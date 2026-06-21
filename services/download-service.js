/**
 * download-service.js — Dosya İndirme Servisi
 * 
 * Range header destekli dosya stream.
 * Kısmi indirme (resume), Content-Range header'ı.
 * download_count increment.
 */

const { query } = require('./database');
const { readFileStream, fileExists, getFileSize } = require('./storage-service');

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
 * Dosyayı indirme için stream olarak hazırlar.
 * Range header varsa kısmi içerik döner (206 Partial Content).
 * 
 * @param {string} fileId - Dosya UUID'si
 * @param {string|null} rangeHeader - Range header değeri
 * @returns {Promise<Object>} - { statusCode, headers, stream, metadata }
 */
async function serveDownload(fileId, rangeHeader = null) {
  // Metadata'yı PG'den al
  const result = await query(
    `SELECT id, filename, file_size, mime_type, storage_path, expire_at,
            is_encrypted, encryption_iv, encryption_salt, download_count
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

  // Dosya diskte var mı?
  const exists = await fileExists(metadata.storage_path);
  if (!exists) {
    return { statusCode: 404, headers: {}, stream: null, metadata: null };
  }

  // Download count artır
  await query(
    `UPDATE files SET download_count = download_count + 1 WHERE id = $1`,
    [fileId]
  );

  // Range kontrolü
  const range = parseRange(rangeHeader, metadata.file_size);
  const mimeType = metadata.mime_type || 'application/octet-stream';
  const filename = encodeURIComponent(metadata.filename);

  if (range) {
    // 206 Partial Content
    const { stream } = await readFileStream(metadata.storage_path, range.start, range.end);

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': range.contentLength,
      'Content-Range': `bytes ${range.start}-${range.end}/${metadata.file_size}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
      'Cache-Control': 'public, max-age=3600',
    };

    return { statusCode: 206, headers, stream, metadata };
  }

  // 200 OK — Tam dosya
  const { stream } = await readFileStream(metadata.storage_path);

  const headers = {
    'Content-Type': mimeType,
    'Content-Length': metadata.file_size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
    'Cache-Control': 'public, max-age=3600',
  };

  return { statusCode: 200, headers, stream, metadata };
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
            is_encrypted, download_count, created_at
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
