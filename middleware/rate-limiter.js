/**
 * rate-limiter.js — IP-based Sliding Window Rate Limiter Middleware
 *
 * Strateji: In-memory Map ile sliding window.
 * IP adresleri hash'lenerek kullanılır (privacy).
 * banned_ips PostgreSQL tablosundan hash'li IP ile kontrol edilir (kalıcı, TTL destekli).
 *
 * Config'den okunan değerler:
 *   - rate_limit_requests (varsayılan: 10)
 *   - rate_limit_window_minutes (varsayılan: 60)
 *
 * Akış:
 *   1. IP adresini hash'le
 *   2. banned_ips tablosunda hash'li IP var mı? → VAR: 403 Forbidden
 *   3. In-memory Map'te hash'li IP'nin son pencere istek sayısına bak
 *   4. Limit aşıldı mı? → EVET: 429 Too Many Requests + Retry-After header
 *   5. Limit aşılmadı → sayacı artır, next() çağır
 */

const { getHashedClientIP, isIPBanned } = require('../services/ip-service');

// =========================================================================
// In-Memory Rate Limit Store
// =========================================================================

/**
 * Map<ip, { count, windowStart }>
 * Her IP için sliding window içindeki istek sayısını tutar.
 */
const rateLimitMap = new Map();

// Varsayılan değerler (config servisi yüklenene kadar)
let maxRequests = 10;
let windowMinutes = 60;

// =========================================================================
// Config'den Değerleri Yükle
// =========================================================================

/**
 * Config servisinden rate limit değerlerini günceller.
 * Config servisi henüz yoksa varsayılan değerler kullanılır.
 */
async function loadConfig() {
  try {
    const { getConfig } = require('../services/config-service');
    const requests = await getConfig('rate_limit_requests');
    const window = await getConfig('rate_limit_window_minutes');

    if (requests) maxRequests = parseInt(requests);
    if (window) windowMinutes = parseInt(window);
  } catch (err) {
    // Config servisi henüz yoksa varsayılan değerlerle devam et
    console.log('[RateLimiter] Config service not available, using defaults.');
  }
}

// =========================================================================
// Rate Limit Middleware
// =========================================================================

/**
 * Gelen isteği rate limit kontrolünden geçirir.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} - İstek kabul edildiyse true, engellendiyse false
 */
async function rateLimitMiddleware(req, res) {
  const ipHash = getHashedClientIP(req);

  // -----------------------------------------------------------------------
  // 1. Banned IP kontrolü (PG, hash'li)
  // -----------------------------------------------------------------------
  const banned = await isIPBanned(ipHash);
  if (banned) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Access denied. Your IP address has been banned.' }));
    return false;
  }

  // -----------------------------------------------------------------------
  // 2. Sliding window kontrolü (in-memory, hash'li IP ile)
  // -----------------------------------------------------------------------
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  let record = rateLimitMap.get(ipHash);

  if (!record || (now - record.windowStart) > windowMs) {
    // Yeni pencere başlat
    record = { count: 1, windowStart: now };
    rateLimitMap.set(ipHash, record);
    return true;
  }

  // Mevcut pencere içinde
  record.count++;

  if (record.count > maxRequests) {
    // Limit aşıldı
    const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: 'Too many requests. Please try again later.',
      retry_after_seconds: retryAfter,
    }));
    return false;
  }

  return true;
}

// =========================================================================
// Periyodik Temizlik
// =========================================================================

/**
 * In-memory Map'te süresi dolmuş pencereleri temizler.
 * Her 5 dakikada bir çalışır.
 */
setInterval(() => {
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  for (const [ipHash, record] of rateLimitMap.entries()) {
    if ((now - record.windowStart) > windowMs) {
      rateLimitMap.delete(ipHash);
    }
  }
}, 5 * 60 * 1000);

// =========================================================================
// Export
// =========================================================================

module.exports = { rateLimitMiddleware, loadConfig };
