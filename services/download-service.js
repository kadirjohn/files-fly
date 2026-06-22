/**
 * download-service.js — Dosya İndirme Servisi
 * 
 * Bucket mantığı: dosya içeriği Object Storage'da (local/R2/Supabase),
 * DB sadece storage_key + backend tutar.
 *
 * İndirme stratejisi backend'e göre değişir:
 *   - local  : sunucu üzerinden stream (Range destekli, 206 Partial Content)
 *              — video resume, partial download çalışır
 *   - cloud  : presigned URL üretip 302 redirect (sunucu trafiği yok!)
 *              — istemci doğrudan bucket'tan indirir, sunucu sadece imzalar
 *
 * download_count increment her iki durumda da yapılır.
 */

const { query } = require('./database');
const storage = require('./storage');

// =========================================================================
// Range Header Parse
// =========================================================================

/**
 * Range header'ını parse eder.
 * Format: bytes=0-1023, bytes=1024-, bytes=-2048
 * 
 * @param {string} rangeHeader - Range header değeri
 * @param {number} fileSize - Toplam dosya boyutu
 * @returns {{ start: number, end: number, contentLength: number }|null}
 */
function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];

  let start, end;

  if (startStr === '' && endStr === '') {
    return null; // Geçersiz
  }

  if (startStr === '') {
    // bytes=-500 → son 500 byte
    const suffix = parseInt(endStr);
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr);
    if (endStr === '') {
      // bytes=500- → 500'den sona kadar
      end = fileSize - 1;
    } else {
      end = parseInt(endStr);
    }
  }

  // Sınır kontrolü
  if (start >= fileSize) return null;
  if (end >= fileSize) end = fileSize - 1;
  if (start > end) return null;

  return {
    start,
    end,
    contentLength: end - start + 1,
  };
}

// =========================================================================
// Dosya İndirme
// =========================================================================

/**
 * Dosyayı indirme için hazırlar.
 * 
 * Local backend: Range header varsa kısmi içerik döner (206 Partial Content),
 *   stream + headers döndürür.
 * Cloud backend: presigned URL üretir, route 302 redirect yapar.
 *   stream = null, redirectUrl dolu döner.
 *
 * @param {string} fileId - Dosya UUID'si
 * @param {string|null} rangeHeader - Range header değeri
 * @returns {Promise<Object>} - { statusCode, headers, stream, metadata, redirectUrl? }
 */
async function serveDownload(fileId, rangeHeader = null) {
  // Metadata'yı PG'den al (artık storage_backend + storage_key)
  const result = await query(
    `SELECT id, filename, file_size, mime_type, storage_backend, storage_key,
            expire_at, is_encrypted, encryption_iv, encryption_salt, download_count
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (result.rows.length === 0) {
    return { statusCode: 404, headers: {}, stream: null, metadata: null };
  }

  const metadata = result.rows[0];

  // Süresi dolmuş mu?
  if (new Date(metadata.expire_at) < new Date()) {
    return { statusCode: 410, headers: {}, stream: null, metadata: null, gone: true };
  }

  // storage_key yoksa (orphan) → 404
  if (!metadata.storage_key) {
    return { statusCode: 404, headers: {}, stream: null, metadata: null };
  }

  // Download count artır (cloud redirect durumunda da — istek bize geldi)
  await query(
    `UPDATE files SET download_count = download_count + 1 WHERE id = $1`,
    [fileId]
  );

  // Backend'e göre provider al (dosya kendi backend'ini taşır)
  const provider = await storage.getProviderForFile(metadata);

  const mimeType = metadata.mime_type || 'application/octet-stream';
  const filename = encodeURIComponent(metadata.filename);

  // -----------------------------------------------------------------------
  // Cloud backend → presigned URL + 302 redirect
  // -----------------------------------------------------------------------
  if (provider.isCloud) {
    try {
      const opts = {
        expiresIn: 3600, // 1 saat geçerli
        responseContentType: mimeType,
        responseContentDisposition: `inline; filename*=UTF-8''${filename}`,
      };
      const redirectUrl = await provider.getDownloadUrl(metadata.storage_key, opts);
      return {
        statusCode: 302,
        headers: {
          'Location': redirectUrl,
          'Cache-Control': 'private, max-age=3600',
        },
        stream: null,
        metadata,
        redirectUrl,
      };
    } catch (err) {
      console.error(`[Download] Presigned URL failed for ${fileId} (${provider.name}):`, err.message);
      return { statusCode: 500, headers: {}, stream: null, metadata: null };
    }
  }

  // -----------------------------------------------------------------------
  // Local backend → sunucu üzerinden stream (Range destekli)
  // -----------------------------------------------------------------------

  // Dosya diskte var mı?
  const exists = await provider.exists(metadata.storage_key);
  if (!exists) {
    return { statusCode: 404, headers: {}, stream: null, metadata: null };
  }

  // Range kontrolü
  const range = parseRange(rangeHeader, metadata.file_size);

  if (range) {
    // 206 Partial Content
    try {
      const { stream } = await provider.getObjectStream(metadata.storage_key, { start: range.start, end: range.end });

      const headers = {
        'Content-Type': mimeType,
        'Content-Length': range.contentLength,
        'Content-Range': `bytes ${range.start}-${range.end}/${metadata.file_size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
        'Cache-Control': 'public, max-age=3600',
      };

      return { statusCode: 206, headers, stream, metadata };
    } catch (err) {
      console.error(`[Download] Stream (range) failed for ${fileId}:`, err.message);
      return { statusCode: 500, headers: {}, stream: null, metadata: null };
    }
  }

  // 200 OK — Tam dosya
  try {
    const { stream } = await provider.getObjectStream(metadata.storage_key);

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': metadata.file_size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
      'Cache-Control': 'public, max-age=3600',
    };

    return { statusCode: 200, headers, stream, metadata };
  } catch (err) {
    console.error(`[Download] Stream (full) failed for ${fileId}:`, err.message);
    return { statusCode: 500, headers: {}, stream: null, metadata: null };
  }
}

// =========================================================================
// Dosya Metadata
// =========================================================================

/**
 * Dosya metadata'sını döndürür (indirme yapmadan).
 * @param {string} fileId
 * @returns {Promise<Object|null>}
 */
async function getFileMetadata(fileId) {
  const result = await query(
    `SELECT id, filename, file_size, mime_type, direct_url, expire_at,
            is_encrypted, encryption_iv, encryption_salt, download_count, created_at
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (result.rows.length === 0) return null;

  const metadata = result.rows[0];

  // Süresi dolmuş mu?
  if (new Date(metadata.expire_at) < new Date()) {
    return { ...metadata, expired: true };
  }

  return { ...metadata, expired: false };
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  serveDownload,
  getFileMetadata,
  parseRange,
};
