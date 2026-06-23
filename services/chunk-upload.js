/**
 * chunk-upload.js — Chunked Upload Yönetimi
 *
 * Büyük dosyaları parça parça yüklemek için chunked upload servisi.
 *
 * Akış:
 * 1. İstemci dosyayı config'deki chunk_size_mb ile parçalara böler
 * 2. Her chunk POST /api/upload/chunk ile gönderilir
 * 3. Chunk'lar /data/uploads/tmp/{file_id}/chunk_{index} altında biriktirilir
 *    (chunk'lar HER ZAMAN local tmp'de toplanır — resume + hızlı birleştirme için)
 * 4. Son chunk geldiğinde tüm parçalar birleştirilir:
 *    - Local backend → /data/uploads/{key} dosyasına yaz
 *    - Cloud backend (R2/Supabase) → bucket'a stream ile putObject
 * 5. Metadata PG'ye yazılır (storage_backend + storage_key), geçici dizin silinir
 * 6. GET /api/upload/chunk/:id/status ile resume desteği (hangi chunk'lar alındı?)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const storage = require('./storage');
const { getConfig } = require('./config-service');
const { getMimeType, isMimeTypeAllowed, validateFileSize, buildStorageKey } = require('./upload-service');
// sharp lazy import — chunked finalize sırasında image thumbnail üretimi.
let maybeGenerateThumbnail = async () => false;
try {
  ({ maybeGenerateThumbnail } = require('./preview-service'));
} catch (err) {
  console.warn('[ChunkUpload] preview-service yüklenemedi — thumbnail kapalı:', err.message);
}

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 9392}`;

// =========================================================================
// Geçici Chunk Dizini (HER ZAMAN local — backend'den bağımsız)
// =========================================================================

const TMP_DIR = process.env.CHUNK_TMP_DIR || path.join(process.env.UPLOADS_DIR || '/data/uploads', 'tmp');

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
 * Tüm chunk'ları birleştirir, dosyayı aktif storage backend'ine yükler,
 * metadata'yı PG'ye kaydeder, geçici dizini temizler.
 *
 * Strateji (backend'e göre):
 *   - local  : chunk'ları doğrudan /data/uploads/{key} dosyasına yazar (rename/stream)
 *   - cloud  : chunk'ları tek geçici dosyada birleştir, sonra bucket'a stream ile putObject
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
  // MIME type validasyonu (yüklemeden önce — boşa upload yapma)
  // -----------------------------------------------------------------------
  const mimeType = originalMimeType;
  const mimeAllowed = await isMimeTypeAllowed(mimeType);
  if (!mimeAllowed) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`File type "${mimeType}" is not allowed`);
  }

  // -----------------------------------------------------------------------
  // Expire süresi kontrolü (yüklemeden önce — single upload ile aynı davranış)
  // -----------------------------------------------------------------------
  // Önceki sürüm chunk'ları birleştirip bucket'a yazdıktan SONRA Math.min ile
  // sessizce clamp ediyordu — bu, upload-service.js'nin (reject eden) davranışıyla
  // tutarsızdı ve ayrıca orphan blob bırakma riski taşıyordu. Artık chunk'ları
  // birleştirmeden önce reject ediyoruz: over-max expire → hata + tmp dir temizlik.
  const maxExpireStr = await getConfig('max_expire_hours');
  const maxExpireHours = maxExpireStr ? parseInt(maxExpireStr) : 48;
  if (expireHours < 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('Expire time must be at least 1 hour');
  }
  if (expireHours > maxExpireHours) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Expire time cannot exceed ${maxExpireHours} hours`);
  }

  // -----------------------------------------------------------------------
  // Storage key + backend seç
  // -----------------------------------------------------------------------
  const ext = path.extname(filename) || '';
  const storageKey = fileId + ext;
  const provider = await storage.getDefaultProvider();
  const storageBackend = provider.name;

  // -----------------------------------------------------------------------
  // Chunk'ları birleştir ve backend'e yükle
  // -----------------------------------------------------------------------
  let totalBytes = 0;

  if (storageBackend === 'local') {
    // Local: chunk'ları doğrudan hedef dosyaya birleştir (provider.putObject
    // local provider için Buffer bekler — burada stream ile dosyaya yazıp
    // provider'a path üzerinden yüklemek yerine, direkt local dosya yazımı
    // yapmak daha verimli. Bu yüzden local provider'ın uploadsDir'ine yaz.)
    const targetPath = path.join(provider.uploadsDir, storageKey);
    const writeStream = fs.createWriteStream(targetPath);

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(dir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.destroy();
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        throw new Error(`Missing chunk ${i}. Upload cannot be completed.`);
      }
      const chunkData = await fs.promises.readFile(chunkPath);
      writeStream.write(chunkData);
      totalBytes += chunkData.length;
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => err ? reject(err) : resolve());
    });
  } else {
    // Cloud: önce chunk'ları geçici birleştirme dosyasında topla, sonra
    // bucket'a stream ile putObject. (ReadStream, provider.putObject
    // S3-uyumlu provider'da lib-storage Upload ile multipart yükler.)
    const assembledTmpPath = path.join(dir, '_assembled');
    const writeStream = fs.createWriteStream(assembledTmpPath);

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(dir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.destroy();
        throw new Error(`Missing chunk ${i}. Upload cannot be completed.`);
      }
      const chunkData = await fs.promises.readFile(chunkPath);
      writeStream.write(chunkData);
      totalBytes += chunkData.length;
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => err ? reject(err) : resolve());
    });

    // Stream ile bucket'a yükle
    const readStream = fs.createReadStream(assembledTmpPath);
    try {
      await provider.putObject(storageKey, readStream, { contentType: mimeType });
    } finally {
      readStream.destroy();
      try { await fs.promises.unlink(assembledTmpPath); } catch { /* ignore */ }
    }
  }

  // -----------------------------------------------------------------------
  // Dosya boyutu kontrolü (toplam byte)
  // -----------------------------------------------------------------------
  const fileSize = totalBytes;
  const sizeCheck = await validateFileSize(fileSize);
  if (!sizeCheck.valid) {
    // Limit aşımı → upload'u geri al
    try { await provider.deleteObject(storageKey); } catch { /* ignore */ }
    throw new Error(`Total file size exceeds maximum allowed size of ${sizeCheck.maxSizeMB} MB`);
  }

  // --- Aktif backend için depolama kotası kontrolü (admin tarafından girilir) ---
  // Limit aşımı → upload'u geri al (orphan blob önle). Mevcat size-check pattern'i.
  // Kota tanımlı değilse checkBackendQuota false döner → reddetme yok.
  const chunkQuotaExceeded = await storage.checkBackendQuota(storageBackend, fileSize);
  if (chunkQuotaExceeded) {
    try { await provider.deleteObject(storageKey); } catch { /* ignore */ }
    throw new Error('Storage quota exceeded for ' + storageBackend + ' backend');
  }

  // -----------------------------------------------------------------------
  // Metadata'yı PG'ye Yaz (storage_backend + storage_key)
  // -----------------------------------------------------------------------
  // Expire kontrolü finalize başında (chunk'ları birleştirmeden önce) yapıldı;
  // burada expireHours güvenli, clamp'e gerek yok.
  const expireAt = new Date(Date.now() + (expireHours || 1) * 60 * 60 * 1000).toISOString();
  // URL'ler relative path olarak saklanır — frontend/indirme kendi host'una göre çözümler.
  const directUrl = `/api/files/${fileId}/dl`;
  const previewUrl = `/files/${fileId}`;

  const result = await query(
    `INSERT INTO files (id, session_id, ip_hash, filename, file_size, mime_type,
                        storage_backend, storage_key, direct_url, expire_at, is_encrypted,
                        encryption_iv, encryption_salt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, filename, file_size, mime_type, direct_url, expire_at, is_encrypted, created_at`,
    [
      fileId,
      sessionId,
      ipHash,
      filename,
      fileSize,
      mimeType,
      storageBackend,
      storageKey,
      directUrl,
      expireAt,
      isEncrypted,
      encryptionIV,
      encryptionSalt,
    ]
  );

  const fileMetadata = result.rows[0];

  // -----------------------------------------------------------------------
  // Image dosyaları için thumbnail üret (preview için compressed kopya).
  // Şifreli dosyalar (ciphertext) ve image olmayanlar otomatik atlanır.
  // Thumbnail her zaman local diskte; cloud kaynak için buffer çekip sharp'a veririz.
  // -----------------------------------------------------------------------
  try {
    await maybeGenerateThumbnail(fileId, storageBackend, storageKey, mimeType, isEncrypted, fileSize);
  } catch (err) {
    console.error(`[ChunkUpload] Thumbnail generation failed for ${fileId}:`, err.message);
  }

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
