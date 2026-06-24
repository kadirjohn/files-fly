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
// Presigned URL Ömrü (Cloud backend indirme linki geçerlilik süresi)
// =========================================================================
// Kullanıcının upload sırasında seçtiği "expire" süresi artık hem dosya ömrü
// (files.expire_at) hem de indirme linkinin (presigned URL) geçerlilik süresi
// olarak kullanılır. Link ömrü = dosyanın kalan ömrü (expire_at - now).
//
// PRESIGN_MAX_SECONDS: güvenlik ağı üst sınırı. AWS S3 / Cloudflare R2 /
// Supabase S3-uyumlu presigner'ları SigV4 ile en fazla 7 gün (604800 sn)
// imzalar. Normal kullanımda (max_expire_hours=48 → 172800 sn) bu sınır
// hiç devreye girmez; sadece gelecekte admin max_expire_hours'ı çok
// yükseltirse makul bir link ömrü korur.
const PRESIGN_MAX_SECONDS = 604800; // 7 gün
const PRESIGN_MIN_SECONDS = 60;     // 60 sn floor — dosya 1 dk içinde expire olsa bile
                                      // browser redirect'i takip edemeden 404 olmasın

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
 * @param {Object} [opts] - { forceStream?: boolean }
 *   forceStream: true ise cloud backend'te bile presigned 302 redirect yerine
 *   SUNUCU üzerinden stream döndür. Preview (<video>/<img> src) için kullanılır —
 *   cross-origin redirect bazı tarayıcılarda/CSP'lerde medya elementlerini bozduğu
 *   için preview yolunu same-origin'e zorlar. İndirme (/dl) redirect'te kalır
 *   (sunucu trafiği yok). Maliyet: preview başına sunucu trafiği; ama preview zaten
 *   geçici/tek seferlik.
 * @returns {Promise<Object>} - { statusCode, headers, stream, metadata, redirectUrl? }
 */
async function serveDownload(fileId, rangeHeader = null, opts = {}) {
  const { forceStream = false } = opts;
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
  // Cloud backend → presigned URL + 302 redirect (SADECE şifresiz dosyalar)
  // -----------------------------------------------------------------------
  // Link ömrü = dosyanın kalan ömrü (expire_at - now). Böylece kullanıcı
  // "48 saat" seçtiyse, üretilen bucket linki ~48 saat geçerli olur — dosya
  // ömrüyle link ömrü aynı, kullanıcının zihinsel modeliyle uyumlu.
  // (410 expired kontrolü yukarıda yapıldı → expire_at > now garanti.)
  //
  // ÖNEMLİ — şifreli dosyalar (is_encrypted) presigned redirect KULLANMAZ:
  //   Şifresiz dosyalar <img>/<video src> ile doğrudan bucket'tan yüklenir
  //   (cross-origin redirect sorun değildir — img tag CORS'a tabi değildir).
  //   Ama şifreli dosyalar frontend'de fetch() + arrayBuffer() ile çekilip
  //   AES-GCM deşifre edilir. Cross-origin redirect (302 → Supabase URL)
  //   sonrası fetch arrayBuffer güvenilmez oluyor (opaque response / CORS
  //   redirect kısıtları → "Failed to fetch"). Bu yüzden şifreli dosyalar
  //   cloud backend'te bile SUNUCU ÜZERİNDEN stream edilir (presigned değil).
  //   Sunucu bucket'tan okuyup tarayıcıya stream eder; tarayıcı same-origin
  //   fetch ile arrayBuffer'ı güvenle alır. (Maliyet: sunucu trafiği, ama
  //   şifreli dosyalar zaten blob olarak işlenmek zorunda — kaçınılmaz.)
  // forceStream (preview yolu) → cloud şifresiz olsa bile presigned redirect dalını
  // atla, aşağıdaki same-origin stream dalına düş. Böylece <video>/<img> src her
  // durumda kendi alanımızdan yüklenir — CSP/cross-origin redirect sorunu olmaz.
  if (provider.isCloud && !metadata.is_encrypted && !forceStream) {
    try {
      const remainMs = new Date(metadata.expire_at).getTime() - Date.now();
      const remainSec = Math.max(PRESIGN_MIN_SECONDS, Math.floor(remainMs / 1000));
      const expiresIn = Math.min(remainSec, PRESIGN_MAX_SECONDS);

      const opts = {
        expiresIn,
        responseContentType: mimeType,
        responseContentDisposition: `inline; filename*=UTF-8''${filename}`,
      };
      const redirectUrl = await provider.getDownloadUrl(metadata.storage_key, opts);
      return {
        statusCode: 302,
        headers: {
          'Location': redirectUrl,
          // 302 redirect response cache süresi hedef linkin geçerliliğiyle hizalı
          'Cache-Control': `private, max-age=${expiresIn}`,
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
  // Sunucu üzerinden stream (local backend + cloud şifreli dosyalar)
  // -----------------------------------------------------------------------
  // Bu dal artık iki durumda çalışır:
  //   - local backend (Range destekli, her dosya)
  //   - cloud backend + şifreli dosya (yukarıdaki presigned dalına düşmedi →
  //     burada provider.getObjectStream ile bucket'tan okuyup sunucudan stream)

  // Dosya diskte/bucket'ta var mı?
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
