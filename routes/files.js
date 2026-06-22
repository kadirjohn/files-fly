/**
 * routes/files.js — Dosya Metadata ve İndirme Route'ları
 * 
 * GET /api/files/:id     — Dosya metadata
 * GET /api/files/:id/dl  — Dosya indirme (stream, Range destekli)
 */

const { addRoute, sendJSON, sendError, serveStaticFile } = require('../server');
const { serveDownload, getFileMetadata } = require('../services/download-service');
const { generateThumbnail } = require('../services/preview-service');
const { fileExists, readFileStream, getThumbPath, getThumbFailMarkerPath } = require('../services/storage-service');
const { query } = require('../services/database');

// Thumbnail üretimi için kaynak dosya boyut limiti (preview-service ile aynı).
const THUMB_MAX_SRC_BYTES = 50 * 1024 * 1024; // 50MB

// =========================================================================
// GET /files/:id — Dosya Önizleme Sayfası (HTML)
// =========================================================================
// /api/files/:id JSON metadata döndürürken, /files/:id kullanıcıya yönelik
// önizleme sayfası (file.html) sunar. file.js client-side metadata çekip render eder.

addRoute('GET', '/files/:id', async (req, res, params, body) => {
  // file.html statik sayfasını sun (client-side fileId'yi URL'den çıkarıp metadata çeker)
  const served = serveStaticFile('/file.html', res);
  if (!served) {
    // file.html bulunamazsa (kurulum hatası) 404 gönder
    sendError(res, 404, 'Preview page not available');
  }
});

// /files/:id/dl → kullanıcı dostu kısa link.
// Şifreli dosyalar için ham /api/files/:id/dl binary döndürür (kullanıcıya anlamsız
// ciphertext gösterir). Bu yüzden şifreli dosyalarda önizleme sayfasına (parola gate)
// yönlendir; şifresiz dosyalarda doğrudan indirmeye yönlendir.
addRoute('GET', '/files/:id/dl', async (req, res, params, body) => {
  const fileId = params.id;
  if (!fileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return sendError(res, 400, 'Invalid file ID format');
  }

  try {
    const metadata = await getFileMetadata(fileId);
    if (metadata && !metadata.expired && metadata.is_encrypted) {
      // Şifreli → önizleme sayfasındaki parola gate'e yönlendir
      res.writeHead(302, { Location: `/files/${fileId}` });
      res.end();
      return;
    }
  } catch (err) {
    // Metadata alınamazsa doğrudan indirmeye düş (en iyi çaba)
  }

  // Şifresiz (veya metadata alınamadı) → doğrudan indirme
  res.writeHead(302, { Location: `/api/files/${fileId}/dl` });
  res.end();
});

// =========================================================================
// GET /api/files/:id — Dosya Metadata
// =========================================================================

addRoute('GET', '/api/files/:id', async (req, res, params, body) => {
  const fileId = params.id;

  if (!fileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return sendError(res, 400, 'Invalid file ID format');
  }

  try {
    const metadata = await getFileMetadata(fileId);

    if (!metadata) {
      return sendError(res, 404, 'File not found');
    }

    if (metadata.expired) {
      return sendJSON(res, 410, {
        error: 'File has expired and been deleted',
        id: metadata.id,
        filename: metadata.filename,
        expired: true,
      });
    }

    sendJSON(res, 200, {
      id: metadata.id,
      filename: metadata.filename,
      file_size: metadata.file_size,
      mime_type: metadata.mime_type,
      direct_url: metadata.direct_url,
      expire_at: metadata.expire_at,
      is_encrypted: metadata.is_encrypted,
      // Şifreli dosyalar için client-side deşifreleme parametreleri (parola gate).
      // Parola kullanıcıdan alınır, PBKDF2 key türetimi tarayıcıda yapılır.
      encryption_iv: metadata.encryption_iv || null,
      encryption_salt: metadata.encryption_salt || null,
      download_count: metadata.download_count,
      created_at: metadata.created_at,
      expired: false,
    });
  } catch (err) {
    console.error('[Files] Error getting metadata:', err.message);
    sendError(res, 500, 'Internal server error');
  }
});

// =========================================================================
// GET /api/files/:id/thumb — Image Thumbnail (compressed, public)
// =========================================================================
// Image preview için compressed thumbnail döndürür (sharp ile üretilmiş,
// /data/thumbs/:id.jpg'de cache'lenir). Upload sırasında üretilmemişse burada
// talep üzerine üretilir. Şifreli dosyalar (ciphertext) ve image olmayanlar
// için 404 döner — frontend fallback olarak full /dl kullanır.

addRoute('GET', '/api/files/:id/thumb', async (req, res, params, body) => {
  const fileId = params.id;

  if (!fileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return sendError(res, 400, 'Invalid file ID format');
  }

  try {
    // Doğrudan metadata çek (storage_path + file_size gerekli)
    const result = await query(
      `SELECT id, mime_type, storage_path, is_encrypted, expire_at, file_size
       FROM files WHERE id = $1`,
      [fileId]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'File not found');
    }
    const file = result.rows[0];

    // Süresi dolmuş
    if (new Date(file.expire_at) < new Date()) {
      return sendError(res, 410, 'File has expired');
    }
    // Şifreli dosyalar (ciphertext) ve image olmayanlar → thumbnail yok
    if (file.is_encrypted) {
      return sendError(res, 404, 'Thumbnail not available for encrypted files');
    }
    if (!file.mime_type || !file.mime_type.startsWith('image/')) {
      return sendError(res, 404, 'Thumbnail only available for images');
    }

    const thumbPath = getThumbPath(fileId);
    const failMarkerPath = getThumbFailMarkerPath(fileId);

    // Negative cache hit — daha önce üretim başarısız oldu, sharp'ı tetikleme (DoS önlemi).
    if (await fileExists(failMarkerPath)) {
      return sendError(res, 404, 'Thumbnail not available');
    }

    // Thumbnail cache'te var mı? Yoksa üret.
    if (!(await fileExists(thumbPath))) {
      // RAM koruması: 50MB'den büyük imajlar için on-demand üretim de yapılmaz.
      if (file.file_size && file.file_size > THUMB_MAX_SRC_BYTES) {
        return sendError(res, 404, 'Thumbnail not available (source too large)');
      }
      try {
        await generateThumbnail({ id: fileId, storage_path: file.storage_path, mime_type: file.mime_type });
      } catch (genErr) {
        console.error('[Files] Thumbnail generation failed:', genErr.message);
      }
    }
    // Hâlâ yoksa (sharp yok / decode hatası / negative cache) → 404, frontend full /dl'ye düşer
    if (!(await fileExists(thumbPath))) {
      return sendError(res, 404, 'Thumbnail not available');
    }

    // Stream et
    const { stream, size } = await readFileStream(thumbPath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': size,
      'Cache-Control': 'public, max-age=86400',
    });
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('[Files] Thumb stream error:', err.message);
      if (!res.headersSent) sendError(res, 500, 'Error reading thumbnail');
      else res.destroy();
    });
  } catch (err) {
    console.error('[Files] Thumbnail error:', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to generate thumbnail');
  }
});

// =========================================================================
// GET /api/files/:id/dl — Dosya İndirme
// =========================================================================

addRoute('GET', '/api/files/:id/dl', async (req, res, params, body) => {
  const fileId = params.id;

  if (!fileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return sendError(res, 400, 'Invalid file ID format');
  }

  try {
    const rangeHeader = req.headers.range || null;
    const result = await serveDownload(fileId, rangeHeader);

    if (result.statusCode === 404) {
      return sendError(res, 404, 'File not found');
    }

    if (result.statusCode === 410) {
      return sendError(res, 410, 'File has expired and been deleted');
    }

    // Stream'i pipe et
    res.writeHead(result.statusCode, result.headers);

    if (result.stream) {
      result.stream.pipe(res);

      // Stream hatalarını yönet
      result.stream.on('error', (err) => {
        console.error('[Files] Stream error:', err.message);
        if (!res.headersSent) {
          sendError(res, 500, 'Error reading file');
        } else {
          res.destroy();
        }
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[Files] Error serving download:', err.message);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal server error');
    }
  }
});
