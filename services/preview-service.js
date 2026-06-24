/**
 * preview-service.js — Admin Dosya Önizleme Servisi
 *
 * MIME type'a göre dosya içeriğini önizleme için hazırlar:
 * - text/* → içerik okur, ilk 100KB döndürür
 * - image/* → direct URL (thumbnail) — sharp ile küçültülmüş JPEG, diske cache'lenir
 * - video/*, audio/* → direct URL (stream)
 * - application/pdf → direct URL
 * - Diğer → "Preview not available"
 *
 * Bucket mantığı: kaynak dosya içeriği artık Object Storage'da (local/R2/Supabase).
 * Text preview ve thumbnail üretimi için `provider.getObjectBuffer()` ile içeriği çekeriz.
 * Thumbnail'lar her zaman local diskte cache'lenir (küçük + sık erişilen).
 *
 * ÖNEMLİ: Image preview base64 data URI döndürmüyor — thumbnail URL döndürür;
 * tarayıcı streaming ile düzgün yükler.
 */

const fs = require('fs');
const { query } = require('./database');
const storage = require('./storage');
const { fileExists, ensureThumbsDir, ensureThumbSubDir, getThumbPath, getThumbFailMarkerPath } = require('./storage-service');

// sharp lazy-load — bağımlılık yoksa bile text/video/pdf preview çalışmaya devam etsin
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('[Preview] sharp module not available — image thumbnails disabled.');
}

// =========================================================================
// Preview Limitleri
// =========================================================================

const TEXT_PREVIEW_MAX = 100 * 1024;  // 100KB
const THUMB_MAX_WIDTH = 800;          // Thumbnail maksimum genişlik (px)
const THUMB_MAX_HEIGHT = 600;         // Thumbnail maksimum yükseklik (px)
const THUMB_QUALITY = 80;             // JPEG kalitesi (1-100)
// Kaynak dosya boyut limiti — bu değeri aşan imajlar için thumbnail üretilmez
// (sharp'ın RAM tüketimini sınırlamak için). Frontend fallback olarak /dl kullanır.
// 50MB: makul bir üst sınır — modern telefon fotoğrafları genelde <20MB.
const THUMB_MAX_SRC_BYTES = 50 * 1024 * 1024; // 50MB

// =========================================================================
// Ana Preview İşlemi
// =========================================================================

/**
 * Dosya önizleme verisini hazırlar.
 * 
 * @param {string} fileId - Dosya UUID'si
 * @returns {Promise<Object>} - { type, content, mime_type, filename }
 */
async function getPreview(fileId) {
  // Metadata'yı al (artık storage_backend + storage_key)
  const result = await query(
    `SELECT id, filename, file_size, mime_type, storage_backend, storage_key,
            expire_at, is_encrypted, encryption_iv, encryption_salt
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (result.rows.length === 0) {
    return { type: 'error', content: 'File not found' };
  }

  const file = result.rows[0];

  // Süresi dolmuş mu?
  if (new Date(file.expire_at) < new Date()) {
    return { type: 'error', content: 'File has expired' };
  }

  // storage_key yoksa (orphan)
  if (!file.storage_key) {
    return { type: 'error', content: 'File storage key missing' };
  }

  const mimeType = file.mime_type || 'application/octet-stream';

  // -----------------------------------------------------------------------
  // Şifreli dosyalar: ham içerik ciphertext'tir (text/image/video/pdf preview
  // anlamsız olur). Admin paneli parola gate ile deşifre edip preview gösterir.
  // Burada sadece şifreleme metadata'sını döndür.
  // -----------------------------------------------------------------------
  if (file.is_encrypted) {
    return {
      type: 'encrypted',
      id: file.id,
      mime_type: mimeType,
      filename: file.filename,
      is_encrypted: true,
      encryption_iv: file.encryption_iv || null,
      encryption_salt: file.encryption_salt || null,
      file_size: file.file_size,
      // Ham ciphertext indirme URL'i (admin parolayı girdikten sonra fetch eder).
      // ?preview=1 → cloud backend'te same-origin stream (cross-origin redirect fetch
      // arrayBuffer güvenilmezliğini aşar — decrypt için kritik).
      download_url: `/api/files/${file.id}/dl?preview=1`,
      content: null,
    };
  }

  // -----------------------------------------------------------------------
  // MIME type'a göre preview stratejisi
  // -----------------------------------------------------------------------

  // Text dosyaları → içerik oku (provider.getObjectBuffer)
  if (isTextMime(mimeType)) {
    return previewText(file);
  }

  // Resim dosyaları → direct URL (sharp ile thumbnail, diske cache'lenir)
  if (mimeType.startsWith('image/')) {
    return previewImage(file);
  }

  // Video/Ses → direct URL (?preview=1 → cloud'ta same-origin stream)
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return {
      type: 'media',
      mime_type: mimeType,
      filename: file.filename,
      url: `/api/files/${file.id}/dl?preview=1`,
      content: null,
    };
  }

  // PDF → direct URL (tarayıcı inline açar; ?preview=1 → same-origin stream)
  if (mimeType === 'application/pdf') {
    return {
      type: 'pdf',
      mime_type: mimeType,
      filename: file.filename,
      url: `/api/files/${file.id}/dl?preview=1`,
      content: null,
    };
  }

  // Diğer → preview yok
  return {
    type: 'unsupported',
    mime_type: mimeType,
    filename: file.filename,
    content: `Preview not available for ${mimeType} files.`,
  };
}

// =========================================================================
// Text Preview (provider üzerinden buffer okuma)
// =========================================================================

async function previewText(file) {
  try {
    const provider = await storage.getProviderForFile(file);

    // Cloud backend'lerde ilk N byte'ı partial okuyamayız (S3 Range var ama
    // basitlik için buffer çek + slice). 100KB limit küçük olduğu için sorun değil.
    // Local provider buffer'ı tüm dosya boyutunda okur — text preview için
    // ilk 100KB yeterli, ama buffer yine de tamamı. Büyük text dosyaları için
    // alternatif: getObjectStream + ilk N byte. Şimdilik basit yol.
    const buffer = await provider.getObjectBuffer(file.storage_key);
    const slice = buffer.subarray(0, TEXT_PREVIEW_MAX);
    const content = slice.toString('utf-8');
    const truncated = buffer.length > TEXT_PREVIEW_MAX;

    return {
      type: 'text',
      mime_type: file.mime_type,
      filename: file.filename,
      content,
      truncated,
      total_size: file.file_size,
    };
  } catch (err) {
    return { type: 'error', content: `Error reading file: ${err.message}` };
  }
}

// =========================================================================
// Image Preview — Sharp Thumbnail (cache'li)
// =========================================================================

/**
 * Resim dosyası için preview metadata döndürür.
 * Artık base64 data URI döndürmüyor — bunun yerine thumbnail ve full URL döndürür.
 * Thumbnail, sharp ile küçültülüp /data/thumbs/ altında cache'lenir.
 *
 * Tarayıcı <img src="/api/admin/files/:id/preview-img"> ile streaming yükler.
 * "Tam çözünürlük" için full_url (/api/files/:id/dl) gösterilir.
 */
async function previewImage(file) {
  // sharp yoksa fallback: direct URL (tam çözünürlük, thumbnail yok)
  if (!sharp) {
    return {
      type: 'image',
      mime_type: file.mime_type,
      filename: file.filename,
      thumbnail_url: null,       // thumbnail kullanılamıyor
      full_url: `/api/files/${file.id}/dl?preview=1`,
      content: null,
      total_size: file.file_size,
    };
  }

  // Thumbnail'i üret/cache'den al (endpoint çağrıldığında lazım olacak)
  let thumbReady = true;
  try {
    await generateThumbnail(file);
  } catch (err) {
    console.error(`[Preview] Thumbnail generation failed for ${file.id}:`, err.message);
    thumbReady = false;
  }

  return {
    type: 'image',
    mime_type: file.mime_type,
    filename: file.filename,
    thumbnail_url: thumbReady ? `/api/admin/files/${file.id}/preview-img` : null,
    full_url: `/api/files/${file.id}/dl?preview=1`,
    content: null,
    total_size: file.file_size,
  };
}

/**
 * Sharp ile thumbnail üretir ve diske cache'ler.
 * Eğer thumbnail zaten varsa (cache hit) tekrar üretmez.
 *
 * Strateji:
 *   - Maksimum 800x600 px, en-boy oranını korur (fit: inside)
 *   - JPEG formatı, kalite 80 (küçük boyut, hızlı yükleme)
 *   - /data/thumbs/:fileId.jpg yolunda saklanır
 *   - Kaynak içeriği provider.getObjectBuffer() ile çekilir (local veya cloud)
 *
 * @param {Object} file - { id, storage_backend, storage_key, mime_type }
 * @returns {Promise<string>} - Thumbnail dosya yolu
 */
async function generateThumbnail(file) {
  if (!sharp) throw new Error('sharp not available');

  const thumbPath = getThumbPath(file.id);
  const failMarkerPath = getThumbFailMarkerPath(file.id);

  // Cache hit — thumbnail zaten var
  if (await fileExists(thumbPath)) {
    return thumbPath;
  }

  // Negative cache hit — daha önce üretim başarısız oldu, tekrar deneme (DoS önlemi).
  if (await fileExists(failMarkerPath)) {
    throw new Error(`Thumbnail generation previously failed for ${file.id} (negative cache hit)`);
  }

  // Alt dizini oluştur (sub-directory hashing)
  await ensureThumbSubDir(file.id);

  // Kaynak içeriğini provider'dan çek (Buffer). sharp Buffer kabul eder.
  const provider = await storage.getProviderForFile(file);
  const sourceBuffer = await provider.getObjectBuffer(file.storage_key);

  // sharp ile küçült + JPEG'e çevir. Başarısız olursa negative cache marker yaz.
  try {
    await sharp(sourceBuffer)
      .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, {
        fit: 'inside',       // En-boy oranını koru, sığdır
        withoutEnlargement: true,  // Küçük resimleri büyütme
      })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath);
    return thumbPath;
  } catch (err) {
    // Negative cache: 0 byte'lık .fail marker yaz ki sonraki istekler
    // sharp'ı tekrar tetiklemesin (bozuk imaja sürekli istek = DoS).
    try {
      await fs.promises.writeFile(failMarkerPath, Buffer.alloc(0));
    } catch (markerErr) {
      // Marker yazılamazsa kritik değil — sadece logla
      console.error(`[Preview] Failed to write negative cache marker for ${file.id}:`, markerErr.message);
    }
    throw err;
  }
}

// =========================================================================
// MIME Type Kontrolü
// =========================================================================

/**
 * MIME type'ın text tabanlı olup olmadığını kontrol eder.
 */
function isTextMime(mimeType) {
  const textTypes = [
    'text/',
    'application/json',
    'application/javascript',
    'application/xml',
    'application/x-httpd-php',
    'application/x-sh',
    'application/x-python',
    'application/x-yaml',
    'application/x-toml',
    'application/sql',
    'message/',
  ];

  return textTypes.some(t => mimeType.startsWith(t));
}

/**
 * Upload sırasında çağrılır: image dosyaları için thumbnail üretir.
 * Şifreli dosyalar (ciphertext) ve image olmayanlar atlanır.
 *
 * NOT: Artık storagePath yerine (storageBackend, storageKey) alır — bucket
 * mantığı. Thumbnail her zaman local diskte; kaynak içeriği provider'dan çekilir.
 *
 * @param {string} fileId
 * @param {string} storageBackend - 'local' | 'r2' | 'supabase'
 * @param {string} storageKey - object key
 * @param {string} mimeType
 * @param {boolean} isEncrypted
 * @param {number} fileSizeBytes
 * @returns {Promise<boolean>} - Thumbnail üretildiyse true
 */
async function maybeGenerateThumbnail(fileId, storageBackend, storageKey, mimeType, isEncrypted, fileSizeBytes) {
  // Şifreli dosyaların içeriği ciphertext'tir → sharp decode edemez, atla.
  if (isEncrypted) return false;
  // Sadece image/* için thumbnail (diğer türler zaten indirilmeli).
  if (!mimeType || !mimeType.startsWith('image/')) return false;
  if (!sharp) return false;

  // RAM koruması: 50MB'den büyük imajlar için thumbnail üretilmez.
  // sharp bu boyutta anlık yüksek bellek tüketir; frontend /dl'ye düşer.
  if (fileSizeBytes && fileSizeBytes > THUMB_MAX_SRC_BYTES) {
    console.log(`[Preview] Skipping thumbnail for ${fileId}: source ${fileSizeBytes} bytes > ${THUMB_MAX_SRC_BYTES} limit`);
    return false;
  }

  try {
    await generateThumbnail({ id: fileId, storage_backend: storageBackend, storage_key: storageKey, mime_type: mimeType });
    return true;
  } catch (err) {
    console.error(`[Preview] Thumbnail generation failed at upload for ${fileId}:`, err.message);
    return false;
  }
}

// =========================================================================
// Export
// =========================================================================

module.exports = { getPreview, generateThumbnail, maybeGenerateThumbnail };
