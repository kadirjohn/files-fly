/**
 * preview-service.js — Admin Dosya Önizleme Servisi
 * 
 * MIME type'a göre dosya içeriğini önizleme için hazırlar:
 * - text/* → içerik okur, ilk 100KB döndürür
 * - image/* → base64 thumbnail (ilk 500KB)
 * - video/*, audio/* → direct URL (stream)
 * - application/pdf → direct URL
 * - Diğer → "Preview not available"
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const { fileExists, readFile } = require('./storage-service');

// =========================================================================
// Preview Limitleri
// =========================================================================

const TEXT_PREVIEW_MAX = 100 * 1024;  // 100KB
const IMAGE_PREVIEW_MAX = 500 * 1024; // 500KB

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
    `SELECT id, filename, file_size, mime_type, storage_path, expire_at
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
  // MIME type'a göre preview stratejisi
  // -----------------------------------------------------------------------

  // Text dosyaları → içerik oku
  if (isTextMime(mimeType)) {
    return previewText(file);
  }

  // Resim dosyaları → base64 thumbnail
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
// Image Preview
// =========================================================================

async function previewImage(file) {
  try {
    // İlk 500KB'ı oku (thumbnail için yeterli)
    const buffer = file.file_size <= IMAGE_PREVIEW_MAX
      ? await readFile(file.storage_path)
      : await readFilePartial(file.storage_path, IMAGE_PREVIEW_MAX);

    const base64 = buffer.toString('base64');
    const dataUri = `data:${file.mime_type};base64,${base64}`;

    return {
      type: 'image',
      mime_type: file.mime_type,
      filename: file.filename,
      content: dataUri,
      total_size: file.file_size,
    };
  } catch (err) {
    return { type: 'error', content: `Error reading image: ${err.message}` };
  }
}

/**
 * Dosyanın ilk N byte'ını okur.
 */
async function readFilePartial(storagePath, maxBytes) {
  const fd = await fs.promises.open(storagePath, 'r');
  const buffer = Buffer.alloc(maxBytes);
  const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
  await fd.close();
  return buffer.slice(0, bytesRead);
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

// =========================================================================
// Export
// =========================================================================

module.exports = { getPreview };
