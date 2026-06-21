/**
 * chunk-upload.js — Chunked Upload Yönetimi
 *
 * Büyük dosyaları parça parça yüklemek için chunked upload servisi.
 *
 * Akış:
 * 1. İstemci dosyayı config'deki chunk_size_mb ile parçalara böler
 * 2. Her chunk POST /api/upload/chunk ile gönderilir
 * 3. Chunk'lar /data/uploads/tmp/{file_id}/chunk_{index} altında biriktirilir
 * 4. Son chunk geldiğinde tüm parçalar birleştirilir → /data/uploads/{file_id}.ext
 * 5. Metadata PG'ye yazılır, geçici dizin silinir
 * 6. GET /api/upload/chunk/:id/status ile resume desteği (hangi chunk'lar alındı?)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const { writeFile, ensureUploadDir, UPLOADS_DIR } = require('./storage-service');
const { getConfig } = require('./config-service');
const { getMimeType, isMimeTypeAllowed, validateFileSize } = require('./upload-service');
const { BASE_URL } = require('../server');

// =========================================================================
// Geçici Chunk Dizini
// =========================================================================

const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');

/**
 * Geçici chunk dizininin var olduğundan emin olur.
 */
async function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/**
 * Belirli bir file_id için chunk dizinini döndürür.
 */
function chunkDir(fileId) {
  return path.join(TMP_DIR, fileId);
}

// =========================================================================
// Chunk Alma (receiveChunk)
// =========================================================================

/**
 * Bir chunk'ı alır, diske yazar.
 * Tüm chunk'lar tamamlandığında birleştirir ve metadata'yı PG'ye kaydeder.
 *
 * @param {string} fileId - Upload session UUID (ilk chunk'ta oluşturulur)
 * @param {number} chunkIndex - Bu chunk'ın indeksi (0-based)
 * @param {number} totalChunks - Toplam chunk sayısı
 * @param {Buffer} chunkData - Chunk'ın binary içeriği
 * @param {Object} metadata - Dosya metadata'sı
 * @param {string} metadata.filename - Orijinal dosya adı
 * @param {number} metadata.expireHours - Saklama süresi (saat)
 * @param {string} metadata.sessionId - Kullanıcı session ID
 * @param {string} metadata.ipHash - Hash'lenmiş IP
 * @param {number} metadata.totalChunks - Toplam chunk sayısı
 * @param {string|null} metadata.password - Parola (opsiyonel)
 * @returns {Promise<Object>} - { chunk_index, complete } veya { complete: true, id, filename, ... }
 */
async function receiveChunk(fileId, chunkIndex, totalChunks, chunkData, metadata) {
  await ensureUploadDir();
  await ensureTmpDir();

  const dir = chunkDir(fileId);

  // Chunk dizinini oluştur (ilk chunk'ta)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });

    // Metadata'yı geçici dosyaya kaydet (birleştirme sırasında kullanmak için)
    const metaPath = path.join(dir, 'metadata.json');
    await fs.promises.writeFile(metaPath, JSON.stringify(metadata));
  }

  // -----------------------------------------------------------------------
  // Boyut validasyonu (biriken toplam boyut)
  // -----------------------------------------------------------------------
  const currentTotalSize = getCurrentTotalSize(dir) + chunkData.length;
  const sizeCheck = await validateFileSize(currentTotalSize);
  if (!sizeCheck.valid) {
    throw new Error(`Total file size exceeds maximum allowed size of ${sizeCheck.maxSizeMB} MB`);
  }

  // -----------------------------------------------------------------------
  // Chunk'ı diske yaz
  // -----------------------------------------------------------------------
  const chunkPath = path.join(dir, `chunk_${chunkIndex}`);
  await fs.promises.writeFile(chunkPath, chunkData);

  // -----------------------------------------------------------------------
  // Tüm chunk'lar tamamlandı mı?
  // -----------------------------------------------------------------------
  const receivedChunks = countReceivedChunks(dir);

  if (receivedChunks >= totalChunks) {
    // Tüm chunk'lar alındı → birleştir ve metadata kaydet
    const result = await finalizeUpload(fileId, dir, metadata);
    return result;
  }

  return {
    chunk_index: chunkIndex,
    complete: false,
  };
}

// =========================================================================
// Chunk Status (Resume Desteği)
// =========================================================================

/**
 * Belirli bir upload session'ı için hangi chunk'ların alındığını döndürür.
 * İstemci yükleme yarıda kaldıysa kaldığı yerden devam edebilir.
 *
 * @param {string} fileId
 * @returns {Promise<Object>} - { file_id, total_chunks, received_chunks, missing_chunks, complete }
 */
async function getChunkStatus(fileId) {
  const dir = chunkDir(fileId);

  if (!fs.existsSync(dir)) {
    return {
      file_id: fileId,
      exists: false,
      message: 'Upload session not found. Please start a new upload.',
    };
  }

  // Metadata dosyasını oku
  const metaPath = path.join(dir, 'metadata.json');
  let metadata = {};
  try {
    const metaRaw = await fs.promises.readFile(metaPath, 'utf-8');
    metadata = JSON.parse(metaRaw);
  } catch {
    // Metadata yoksa bile chunk'ları say
  }

  const totalChunks = metadata.totalChunks || 0;
  const receivedChunks = countReceivedChunks(dir);
  const missingChunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(dir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      missingChunks.push(i);
    }
  }

  return {
    file_id: fileId,
    filename: metadata.filename || null,
    total_chunks: totalChunks,
    received_chunks: receivedChunks,
    missing_chunks: missingChunks,
    complete: receivedChunks >= totalChunks && totalChunks > 0,
  };
}

// =========================================================================
// Birleştirme (Finalize)
// =========================================================================

/**
 * Tüm chunk'ları birleştirir, dosyayı ana upload dizinine taşır,
 * metadata'yı PG'ye kaydeder, geçici dizini temizler.
 *
 * @param {string} fileId
 * @param {string} dir - Chunk geçici dizini
 * @param {Object} metadata
 * @returns {Promise<Object>} - Tamamlanmış upload metadata'sı
 */
async function finalizeUpload(fileId, dir, metadata) {
  const { filename, expireHours, sessionId, ipHash, password } = metadata;

  // -----------------------------------------------------------------------
  // AES-GCM Parola Koruması (Faz 4.3)
  // -----------------------------------------------------------------------
  const isEncrypted = !!password;
  const encryptionIV = metadata.encryption_iv || null;
  const encryptionSalt = metadata.encryption_salt || null;
  // Orijinal MIME type (şifreleme öncesi)
  const originalMimeType = metadata.mime_type || getMimeType(filename);

  // -----------------------------------------------------------------------
  // Tüm chunk'ları sırayla birleştir
  // -----------------------------------------------------------------------
  const ext = path.extname(filename) || '';
  const storageFilename = fileId + ext;
  const storagePath = path.join(UPLOADS_DIR, storageFilename);

  const writeStream = fs.createWriteStream(storagePath);

  for (let i = 0; i < metadata.totalChunks; i++) {
    const chunkPath = path.join(dir, `chunk_${i}`);

    if (!fs.existsSync(chunkPath)) {
      writeStream.destroy();
      // Eksik chunk varsa temizlik yap
      try { fs.unlinkSync(storagePath); } catch { /* ignore */ }
      throw new Error(`Missing chunk ${i}. Upload cannot be completed.`);
    }

    const chunkData = await fs.promises.readFile(chunkPath);
    writeStream.write(chunkData);
  }

  // Stream'in bitmesini bekle
  await new Promise((resolve, reject) => {
    writeStream.end((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // -----------------------------------------------------------------------
  // MIME type validasyonu
  // -----------------------------------------------------------------------
  const mimeType = originalMimeType;
  const mimeAllowed = await isMimeTypeAllowed(mimeType);
  if (!mimeAllowed) {
    // Geçersiz tür → dosyayı sil
    try { await fs.promises.unlink(storagePath); } catch { /* ignore */ }
    throw new Error(`File type "${mimeType}" is not allowed`);
  }

  // -----------------------------------------------------------------------
  // Dosya boyutunu al
  // -----------------------------------------------------------------------
  const stat = await fs.promises.stat(storagePath);
  const fileSize = stat.size;

  // -----------------------------------------------------------------------
  // Expire süresi kontrolü
  // -----------------------------------------------------------------------
  const maxExpireStr = await getConfig('max_expire_hours');
  const maxExpireHours = maxExpireStr ? parseInt(maxExpireStr) : 48;
  const finalExpireHours = Math.min(expireHours || 1, maxExpireHours);

  // -----------------------------------------------------------------------
  // Metadata'yı PG'ye Yaz
  // -----------------------------------------------------------------------
  const expireAt = new Date(Date.now() + finalExpireHours * 60 * 60 * 1000).toISOString();
  const directUrl = `${BASE_URL}/api/files/${fileId}/dl`;
  const previewUrl = `${BASE_URL}/api/files/${fileId}`;

  const result = await query(
    `INSERT INTO files (id, session_id, ip_hash, filename, file_size, mime_type,
                        storage_path, direct_url, expire_at, is_encrypted,
                        encryption_iv, encryption_salt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, filename, file_size, mime_type, direct_url, expire_at, is_encrypted, created_at`,
    [
      fileId,
      sessionId,
      ipHash,
      filename,
      fileSize,
      mimeType,
      storagePath,
      directUrl,
      expireAt,
      isEncrypted,
      encryptionIV,
      encryptionSalt,
    ]
  );

  const fileMetadata = result.rows[0];

  // -----------------------------------------------------------------------
  // Geçici chunk dizinini temizle
  // -----------------------------------------------------------------------
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[ChunkUpload] Error cleaning tmp dir ${dir}:`, err.message);
  }

  return {
    complete: true,
    ...fileMetadata,
    preview_url: previewUrl,
  };
}

// =========================================================================
// Yardımcılar
// =========================================================================

/**
 * Bir chunk dizininde kaç chunk dosyası olduğunu sayar.
 */
function countReceivedChunks(dir) {
  if (!fs.existsSync(dir)) return 0;

  const files = fs.readdirSync(dir);
  return files.filter(f => f.startsWith('chunk_')).length;
}

/**
 * Bir chunk dizinindeki tüm chunk'ların toplam boyutunu hesaplar.
 */
function getCurrentTotalSize(dir) {
  if (!fs.existsSync(dir)) return 0;

  let total = 0;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file.startsWith('chunk_')) {
      try {
        total += fs.statSync(path.join(dir, file)).size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  receiveChunk,
  getChunkStatus,
};
