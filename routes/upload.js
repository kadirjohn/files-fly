/**
 * routes/upload.js — Dosya Yükleme Route'ları
 * 
 * POST /api/upload        — Tek seferde dosya yükleme
 * POST /api/upload/chunk  — Chunked upload (Faz 4)
 */

const { addRoute, sendJSON, sendError } = require('../server');
const { handleUpload } = require('../services/upload-service');
const { getClientIP } = require('../middleware/session');

// =========================================================================
// POST /api/upload — Dosya Yükleme
// =========================================================================

addRoute('POST', '/api/upload', async (req, res, params, body) => {
  // Session kontrolü
  if (!req.sessionId) {
    return sendError(res, 401, 'Session required. Please reload the page.');
  }

  // Content-Type kontrolü
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendError(res, 400, 'Content-Type must be multipart/form-data');
  }

  // Body kontrolü
  if (!body || !Buffer.isBuffer(body)) {
    return sendError(res, 400, 'No file data received');
  }

  try {
    const ipAddress = getClientIP(req);
    const result = await handleUpload(body, contentType, req.sessionId, ipAddress);

    sendJSON(res, 201, {
      id: result.id,
      filename: result.filename,
      file_size: result.file_size,
      mime_type: result.mime_type,
      direct_url: result.direct_url,
      preview_url: result.preview_url,
      expire_at: result.expire_at,
      is_encrypted: result.is_encrypted,
      created_at: result.created_at,
    });
  } catch (err) {
    console.error('[Upload] Error:', err.message);

    // Hata tipine göre status code
    if (err.message.includes('exceeds maximum')) {
      return sendError(res, 413, err.message);
    }
    if (err.message.includes('not allowed')) {
      return sendError(res, 415, err.message);
    }
    if (err.message.includes('expire')) {
      return sendError(res, 400, err.message);
    }
    if (err.message.includes('No file')) {
      return sendError(res, 400, err.message);
    }

    sendError(res, 500, 'Upload failed. Please try again.');
  }
});

// =========================================================================
// POST /api/upload/chunk — Chunked Upload (Faz 4 placeholder)
// =========================================================================

addRoute('POST', '/api/upload/chunk', async (req, res, params, body) => {
  // Faz 4'te implemente edilecek
  sendError(res, 501, 'Chunked upload not yet implemented');
});
