/**
 * routes/files.js — Dosya Metadata ve İndirme Route'ları
 * 
 * GET /api/files/:id     — Dosya metadata
 * GET /api/files/:id/dl  — Dosya indirme (stream, Range destekli)
 */

const { addRoute, sendJSON, sendError } = require('../server');
const { serveDownload, getFileMetadata } = require('../services/download-service');

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
