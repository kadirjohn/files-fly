/**
 * upload-service.js — Dosya Yükleme İş Mantığı
 * 
 * Multipart form data parse (built-in, zero-dependency).
 * Dosyayı /data/uploads/ altına UUID isimle kaydeder.
 * Metadata'yı PostgreSQL files tablosuna yazar.
 * 
 * Desteklenen:
 * - Tek seferde dosya yükleme (Faz 2)
 * - Chunked upload (Faz 4 — chunk-upload.js ile)
 */

const crypto = require('crypto');
const path = require('path');
const { query } = require('./database');
const { writeFile, ensureUploadDir, UPLOADS_DIR } = require('./storage-service');
const { getConfig } = require('./config-service');
const { BASE_URL } = require('../server');

// =========================================================================
// Multipart Form Data Parser
// =========================================================================

/**
 * multipart/form-data body'sini parse eder.
 * Boundary'ye göre parçaları ayırır, dosya içeriğini ve form alanlarını çıkarır.
 * 
 * @param {Buffer} body - Raw request body
 * @param {string} contentType - Content-Type header (boundary içermeli)
 * @returns {{ fields: Object, files: Array<{filename, contentType, data: Buffer}> }}
 */
function parseMultipart(body, contentType) {
  // Boundary'yi çıkar
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) {
    throw new Error('No boundary found in Content-Type');
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryBuffer = Buffer.from('--' + boundary);
  const endBoundary = Buffer.from('--' + boundary + '--');
  const newline = Buffer.from('\r\n\r\n');

  const fields = {};
  const files = [];

  // Body'yi boundary'lere göre böl
  let pos = 0;
  const parts = [];

  while (pos < body.length) {
    const boundaryPos = body.indexOf(boundaryBuffer, pos);
    if (boundaryPos === -1) break;

    const nextPos = body.indexOf(boundaryBuffer, boundaryPos + boundaryBuffer.length);
    const partEnd = nextPos === -1 ? body.indexOf(endBoundary, boundaryPos) : nextPos;

    if (partEnd === -1) break;

    const part = body.slice(boundaryPos + boundaryBuffer.length + 2, partEnd - 2); // \r\n atla
    parts.push(part);
    pos = partEnd;
  }

  // Her parçayı parse et
  for (const part of parts) {
    const headerEnd = part.indexOf(newline);
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const content = part.slice(headerEnd + newline.length);

    // Content-Disposition header'ını parse et
    const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!dispMatch) continue;

    const fieldName = dispMatch[1];
    const filename = dispMatch[2];

    if (filename) {
      // Dosya alanı
      const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      const fileContentType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

      files.push({
        fieldName,
        filename,
        contentType: fileContentType,
        data: content,
      });
    } else {
      // Normal form alanı
      fields[fieldName] = content.toString('utf-8').trim();
    }
  }

  return { fields, files };
}

// =========================================================================
// MIME Type Tespiti
// =========================================================================

/**
 * Dosya uzantısına göre MIME type belirler.
 * @param {string} filename
 * @returns {string}
 */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// =========================================================================
// Dosya Tipi Validasyonu
// =========================================================================

/**
 * MIME type'ın izin verilen türler arasında olup olmadığını kontrol eder.
 * Config'deki `allowed_mime_types` değerine bakar.
 * '*' = tüm türler izinli.
 * 'image/*' = tüm image türleri izinli.
 * 
 * @param {string} mimeType
 * @returns {Promise<boolean>}
 */
async function isMimeTypeAllowed(mimeType) {
  const allowed = await getConfig('allowed_mime_types');
  if (!allowed || allowed === '*') return true;

  const allowedTypes = allowed.split(',').map(t => t.trim().toLowerCase());

  for (const allowedType of allowedTypes) {
    if (allowedType === '*') return true;
    if (allowedType.endsWith('/*')) {
      const prefix = allowedType.replace('/*', '');
      if (mimeType.startsWith(prefix + '/')) return true;
    }
    if (allowedType === mimeType.toLowerCase()) return true;
  }

  return false;
}

// =========================================================================
// Dosya Boyutu Validasyonu
// =========================================================================

/**
 * Dosya boyutunun limit dahilinde olup olmadığını kontrol eder.
 * @param {number} fileSize - Byte cinsinden
 * @returns {Promise<{valid: boolean, maxSizeMB: number}>}
 */
async function validateFileSize(fileSize) {
  const maxSizeMBStr = await getConfig('max_file_size_mb');
  const maxSizeMB = maxSizeMBStr ? parseInt(maxSizeMBStr) : 100;
  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  return {
    valid: fileSize <= maxSizeBytes,
    maxSizeMB,
  };
}

// =========================================================================
// Ana Upload İşlemi
// =========================================================================

/**
 * Dosya yükleme işlemini gerçekleştirir.
 * 
 * @param {Buffer} body - Raw multipart body
 * @param {string} contentType - Content-Type header
 * @param {string} sessionId - Kullanıcı session ID'si
 * @param {string} ipAddress - Kullanıcı IP adresi
 * @returns {Promise<Object>} - Yüklenen dosyanın metadata'sı
 */
async function handleUpload(body, contentType, sessionId, ipAddress) {
  // Upload dizinini garanti et
  await ensureUploadDir();

  // Multipart parse
  const { fields, files } = parseMultipart(body, contentType);

  if (files.length === 0) {
    throw new Error('No file found in upload request');
  }

  const file = files[0]; // İlk dosyayı al
  const expireHours = parseInt(fields.expire) || 1;
  const password = fields.password || null;

  // -----------------------------------------------------------------------
  // Validasyonlar
  // -----------------------------------------------------------------------

  // Dosya boyutu kontrolü
  const sizeCheck = await validateFileSize(file.data.length);
  if (!sizeCheck.valid) {
    throw new Error(`File size exceeds maximum allowed size of ${sizeCheck.maxSizeMB} MB`);
  }

  // MIME type kontrolü
  const mimeType = file.contentType || getMimeType(file.filename);
  const mimeAllowed = await isMimeTypeAllowed(mimeType);
  if (!mimeAllowed) {
    throw new Error(`File type "${mimeType}" is not allowed`);
  }

  // Expire süresi kontrolü
  const maxExpireStr = await getConfig('max_expire_hours');
  const maxExpireHours = maxExpireStr ? parseInt(maxExpireStr) : 48;
  if (expireHours > maxExpireHours) {
    throw new Error(`Expire time cannot exceed ${maxExpireHours} hours`);
  }
  if (expireHours < 1) {
    throw new Error('Expire time must be at least 1 hour');
  }

  // -----------------------------------------------------------------------
  // Dosyayı Kaydet
  // -----------------------------------------------------------------------

  const fileId = crypto.randomUUID();
  const ext = path.extname(file.filename) || '';
  const storageFilename = fileId + ext;
  const storagePath = path.join(UPLOADS_DIR, storageFilename);

  await writeFile(storagePath, file.data);

  // -----------------------------------------------------------------------
  // Metadata'yı PG'ye Yaz
  // -----------------------------------------------------------------------

  const expireAt = new Date(Date.now() + expireHours * 60 * 60 * 1000).toISOString();
  const directUrl = `${BASE_URL}/api/files/${fileId}/dl`;
  const previewUrl = `${BASE_URL}/api/files/${fileId}`;

  const result = await query(
    `INSERT INTO files (session_id, ip_address, filename, file_size, mime_type,
                        storage_path, direct_url, expire_at, is_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, filename, file_size, mime_type, direct_url, expire_at, is_encrypted, created_at`,
    [
      sessionId,
      ipAddress,
      file.filename,
      file.data.length,
      mimeType,
      storagePath,
      directUrl,
      expireAt,
      false, // Parola koruması Faz 4'te
    ]
  );

  const metadata = result.rows[0];

  return {
    ...metadata,
    preview_url: previewUrl,
  };
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  handleUpload,
  parseMultipart,
  getMimeType,
  isMimeTypeAllowed,
  validateFileSize,
};
