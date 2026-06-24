/**
 * routes/upload.js — Dosya Yükleme Route'ları
 *
 * POST /api/upload        — Tek seferde dosya yükleme
 * POST /api/upload/chunk  — Chunked upload
 * GET  /api/upload/chunk/:id/status — Chunk status (resume)
 */

const { addRoute, sendJSON, sendError } = require('../server');
const { handleUpload } = require('../services/upload-service');
const { receiveChunk, getChunkStatus } = require('../services/chunk-upload');
const { getHashedClientIP } = require('../services/ip-service');

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
    const ipHash = getHashedClientIP(req);
    const result = await handleUpload(body, contentType, req.sessionId, ipHash);

    sendJSON(res, 201, {
      id: result.id,
      filename: result.filename,
      file_size: result.file_size,
      mime_type: result.mime_type,
      direct_url: result.direct_url,
      preview_url: result.preview_url,
      bundle_id: result.bundle_id,
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
    if (err.message.includes('quota')) {
      // Depolama kotası aşımı → 507 Insufficient Storage.
      // Frontend bu durumda t('quotaFull') zengin uyarısını gösterir.
      return sendError(res, 507, err.message);
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
// POST /api/upload/chunk — Chunked Upload
// =========================================================================

addRoute('POST', '/api/upload/chunk', async (req, res, params, body) => {
  // Session kontrolü
  if (!req.sessionId) {
    return sendError(res, 401, 'Session required');
  }

  // Content-Type kontrolü
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendError(res, 400, 'Content-Type must be multipart/form-data');
  }

  if (!body || !Buffer.isBuffer(body)) {
    return sendError(res, 400, 'No chunk data received');
  }

  try {
    // Multipart parse
    const { parseMultipart } = require('../services/upload-service');
    const { fields, files } = parseMultipart(body, contentType);

    if (files.length === 0) {
      return sendError(res, 400, 'No chunk file in request');
    }

    const chunkFile = files[0];
    const fileId = fields.file_id;
    const chunkIndex = parseInt(fields.chunk_index);
    const totalChunks = parseInt(fields.total_chunks);
    const filename = fields.filename;
    const expireHours = parseInt(fields.expire) || 1;

    if (!fileId || isNaN(chunkIndex) || isNaN(totalChunks) || !filename) {
      return sendError(res, 400, 'Missing required fields: file_id, chunk_index, total_chunks, filename');
    }

    const ipHash = getHashedClientIP(req);

    const metadata = {
      filename,
      expireHours,
      sessionId: req.sessionId,
      ipHash,
      totalChunks,
      password: fields.password || null,
      encryption_iv: fields.encryption_iv || null,
      encryption_salt: fields.encryption_salt || null,
      mime_type: fields.mime_type || null,
      bundle_id: fields.bundle_id || null,
      title: fields.title || null,
    };

    const result = await receiveChunk(fileId, chunkIndex, totalChunks, chunkFile.data, metadata);

    if (result.complete) {
      sendJSON(res, 201, {
        complete: true,
        id: result.id,
        filename: result.filename,
        file_size: result.file_size,
        mime_type: result.mime_type,
        direct_url: result.direct_url,
        preview_url: result.preview_url,
        bundle_id: result.bundle_id,
        expire_at: result.expire_at,
        is_encrypted: result.is_encrypted,
        created_at: result.created_at,
      });
    } else {
      sendJSON(res, 200, {
        received: true,
        chunk_index: result.chunk_index,
        complete: false,
      });
    }
  } catch (err) {
    console.error('[Upload] Chunk error:', err.message, err.stack);

    if (err.message.includes('exceeds maximum')) {
      return sendError(res, 413, err.message);
    }
    if (err.message.includes('quota')) {
      // Depolama kotası aşımı → 507 Insufficient Storage.
      return sendError(res, 507, err.message);
    }
    if (err.message.includes('not allowed')) {
      return sendError(res, 415, err.message);
    }
    if (err.message.includes('EntityTooLarge') || err.message.includes('maximum allowed size') || err.message.includes('exceeds the maximum')) {
      return sendError(res, 413, 'File size exceeds the storage backend maximum allowed size. Check your Supabase bucket limits.');
    }
    if (err.message.includes('Expire time')) {
      return sendError(res, 400, err.message);
    }

    sendError(res, 500, 'Chunk upload failed');
  }
});

// =========================================================================
// GET /api/upload/chunk/:id/status — Chunk Status (Resume)
// =========================================================================

addRoute('GET', '/api/upload/chunk/:id/status', async (req, res, params, body) => {
  try {
    const status = await getChunkStatus(params.id);
    sendJSON(res, 200, status);
  } catch (err) {
    console.error('[Upload] Chunk status error:', err.message);
    sendError(res, 500, 'Failed to get chunk status');
  }
});
