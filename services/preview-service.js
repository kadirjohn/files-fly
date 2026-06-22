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
 * ÖNEMLİ: Image preview artık base64 data URI döndürmüyor (7MB foto → 9.3MB
 * base64 string JSON içinde → kırık görüntü + bellek tüketimi). Bunun yerine
 * thumbnail URL döndürülür; tarayıcı streaming ile düzgün yükler.
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const { fileExists, ensureThumbsDir, getThumbPath } = require('./storage-service');

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
  // Metadata'yı al
  const result = await query(
    `SELECT id, filename, file_size, mime_type, storage_path, expire_at,
            is_encrypted, encryption_iv, encryption_salt
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

  // Dosya diskte var mı?
  const exists = await fileExists(file.storage_path);
  if (!exists) {
    return { type: 'error', content: 'File not found on disk' };
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
      // Ham ciphertext indirme URL'i (admin parolayı girdikten sonra fetch eder)
      download_url: `/api/files/${file.id}/dl`,
      content: null,
    };
  }

  // -----------------------------------------------------------------------
  // MIME type'a göre preview stratejisi
  // -----------------------------------------------------------------------

  // Text dosyaları → içerik oku
  if (isTextMime(mimeType)) {
    return previewText(file);
  }

  // Resim dosyaları → direct URL (sharp ile thumbnail, diske cache'lenir)
  if (mimeType.startsWith('image/')) {
    return previewImage(file);
  }

  // Video/Ses → direct URL
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return {
      type: 'media',
      mime_type: mimeType,
      filename: file.filename,
      url: `/api/files/${file.id}/dl`,
      content: null,
    };
  }

  // PDF → direct URL (tarayıcı inline açar)
  if (mimeType === 'application/pdf') {
    return {
      type: 'pdf',
      mime_type: mimeType,
      filename: file.filename,
      url: `/api/files/${file.id}/dl`,
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
// Text Preview
// =========================================================================

async function previewText(file) {
  try {
    const fd = await fs.promises.open(file.storage_path, 'r');
    const buffer = Buffer.alloc(TEXT_PREVIEW_MAX);
    const { bytesRead } = await fd.read(buffer, 0, TEXT_PREVIEW_MAX, 0);
    await fd.close();

    const content = buffer.toString('utf-8', 0, bytesRead);
    const truncated = bytesRead >= TEXT_PREVIEW_MAX && file.file_size > TEXT_PREVIEW_MAX;

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
      full_url: `/api/files/${file.id}/dl`,
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
    full_url: `/api/files/${file.id}/dl`,
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
 *
 * @param {Object} file - { id, storage_path, mime_type }
 * @returns {Promise<string>} - Thumbnail dosya yolu
 */
async function generateThumbnail(file) {
  if (!sharp) throw new Error('sharp not available');

  await ensureThumbsDir();
  const thumbPath = getThumbPath(file.id);

  // Cache hit — thumbnail zaten var
  if (await fileExists(thumbPath)) {
    return thumbPath;
  }

  // sharp ile küçült + JPEG'e çevir
  await sharp(file.storage_path)
    .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, {
      fit: 'inside',       // En-boy oranını koru, sığdır
      withoutEnlargement: true,  // Küçük resimleri büyütme
    })
    .jpeg({ quality: THUMB_QUALITY })
    .toFile(thumbPath);

  return thumbPath;
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
 * @param {string} fileId
 * @param {string} storagePath
 * @param {string} mimeType
 * @param {boolean} isEncrypted
 * @returns {Promise<boolean>} - Thumbnail üretildiyse true
 */
async function maybeGenerateThumbnail(fileId, storagePath, mimeType, isEncrypted) {
  // Şifreli dosyaların içeriği ciphertext'tir → sharp decode edemez, atla.
  if (isEncrypted) return false;
  // Sadece image/* için thumbnail (diğer türler zaten indirilmeli).
  if (!mimeType || !mimeType.startsWith('image/')) return false;
  if (!sharp) return false;

  try {
    await generateThumbnail({ id: fileId, storage_path: storagePath, mime_type: mimeType });
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
