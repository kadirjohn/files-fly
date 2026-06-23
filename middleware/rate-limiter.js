/**
 * rate-limiter.js — IP-based Tiered (Katmanlı) Sliding Window Rate Limiter
 *
 * Strateji: Endpoint türüne göre ayrı bucket'lar (katmanlı rate limiting).
 * IP adresleri hash'lenerek kullanılır (privacy).
 * banned_ips PostgreSQL tablosundan hash'li IP ile kontrol edilir (kalıcı, TTL destekli).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  BUCKET TANIMLARI (tiered)                                          │
 * ├──────────────────────┬───────────┬───────────┬───────────────────────┤
 * │ Bucket               │ Limit     │ Pencere   │ Endpoint'ler          │
 * ├──────────────────────┼───────────┼───────────┼───────────────────────┤
 * │ admin (auth JWT)     │ ∞ (muaf)  │ —         │ /api/admin/* (login hariç) │
 * │ login                │ 5         │ 15 dk     │ POST /api/admin/login │
 * │ upload               │ 300       │ 10 dk     │ POST /api/upload,     │
 * │                      │           │           │ POST /api/upload/chunk│
 * │ download             │ 60        │ 1 dk      │ GET /api/files/:id/dl │
 * │ read                 │ 120       │ 1 dk      │ diğer tüm /api/ route │
 * │                      │           │           │ (session, metadata,   │
 * │                      │           │           │ status, admin/config) │
 * └──────────────────────┴───────────┴───────────┴───────────────────────┘
 *
 * Neden tiered? Eski tasarım "her şeye 10/60dk" uyguluyordu:
 *  - 11 dosya yükleyen kullanıcı 60dk kilitleniyordu
 *  - Chunked upload (20 istek = 1 dosya) anında kırılıyordu
 *  - Admin paneli kullanılamaz oluyordu (JWT'li admin anonimle aynı limitte)
 * Artık her endpoint kategorisi tehdit modeline göre ayrı limite sahip.
 *
 * Config'den okunan değerler (opsiyonel override):
 *   - rate_limit_requests        → read bucket limit (varsayılan: 120)
 *   - rate_limit_window_minutes   → read bucket pencere (varsayılan: 1)
 *
 * Akış:
 *   1. IP adresini hash'le
 *   2. banned_ips tablosunda hash'li IP var mı? → VAR: 403 Forbidden
 *   3. İsteğin path'ine göre bucket belirle
 *   4. Admin bucket → muaf, true döndür
 *   5. İlgili bucket'ın sliding window'unda say
 *   6. Limit aşıldı mı? → EVET: 429 Too Many Requests + Retry-After header
 *   7. Limit aşılmadı → sayacı artır, true döndür
 */

const { getHashedClientIP, isIPBanned } = require('../services/ip-service');

// =========================================================================
// Bucket Tanımları
// =========================================================================

/**
 * Her bucket: { limit, windowMinutes }
 * limit = pencere içinde izin verilen maksimum istek sayısı
 * windowMinutes = sliding window uzunluğu (dakika)
 */
const BUCKETS = {
  admin: { limit: Infinity, windowMinutes: 0 },   // Muaf — JWT koruması yeterli
  login: { limit: 20, windowMinutes: 15 },          // Brute-force koruması (test+debug için 5→20)
  upload: { limit: 300, windowMinutes: 10 },        // Chunked upload'a izin verir
  download: { limit: 60, windowMinutes: 1 },        // Hotlinking/abuse önle
  read: { limit: 200, windowMinutes: 1 },           // Okuma endpoint'leri (120→200, admin panel çok istek atar)
};

/**
 * Config'den override edilebilen bucket'lar (admin panelinden ayarlanabilir).
 * Şimdilik sadece 'read' bucket'ı config'e bağlı; diğerleri sabit güvenlik limiti.
 */
let readLimit = BUCKETS.read.limit;
let readWindowMinutes = BUCKETS.read.windowMinutes;

// =========================================================================
// In-Memory Rate Limit Store — bucket bazlı
// =========================================================================

/**
 * Map<key, { count, windowStart }>
 * key = `${ipHash}:${bucket}` — her IP + bucket kombinasyonu için ayrı sayaç.
 */
const rateLimitMap = new Map();

// =========================================================================
// Bucket Belirleme
// =========================================================================

/**
 * İstek path'ine ve method'una göre bucket adını döndürür.
 *
 * @param {string} method - HTTP method (büyük harf)
 * @param {string} path - URL path (query'siz)
 * @returns {string} bucket adı: 'admin' | 'login' | 'upload' | 'download' | 'read'
 */
function resolveBucket(method, path) {
  // Admin route'ları — login hariç hepsi JWT korumalı → muafiyet
  if (path.startsWith('/api/admin/')) {
    // Login brute-force koruması için ayrı bucket
    if (method === 'POST' && path === '/api/admin/login') {
      return 'login';
    }
    // Public config endpoint'i (auth yok) → read bucket'a dahil et
    if (method === 'GET' && path === '/api/admin/config') {
      return 'read';
    }
    // Geri kalan tüm admin route'ları JWT korumalı → muaf
    return 'admin';
  }

  // Upload endpoint'leri
  if (method === 'POST' && (path === '/api/upload' || path === '/api/upload/chunk')) {
    return 'upload';
  }

  // Download endpoint'i
  if (method === 'GET' && /\/api\/files\/[^/]+\/dl$/.test(path)) {
    return 'download';
  }

  // Bundle zip download — POST ama ağır indirme; generic read limit'i değil,
  // download bucket'ı (per-file /dl ile aynı sınır) ile yönetilsin.
  if (method === 'POST' && /\/api\/bundles\/[^/]+\/download$/.test(path)) {
    return 'download';
  }

  // Diğer tüm /api/ route'ları (session, metadata, chunk status, files metadata)
  return 'read';
}

// =========================================================================
// Config'den Değerleri Yükle
// =========================================================================

/**
 * Config servisinden 'read' bucket değerlerini günceller.
 * Diğer bucket'lar güvenlik için sabit tutulur (config'den değiştirilemez).
 * Config servisi henüz yoksa varsayılan değerler kullanılır.
 */
async function loadConfig() {
  try {
    const { getConfig } = require('../services/config-service');
    const requests = await getConfig('rate_limit_requests');
    const window = await getConfig('rate_limit_window_minutes');

    // Config'den gelen değerler 'read' bucket'ı için geçerli
    if (requests && parseInt(requests) > 0) readLimit = parseInt(requests);
    if (window && parseInt(window) > 0) readWindowMinutes = parseInt(window);
  } catch (err) {
    // Config servisi henüz yoksa varsayılan değerlerle devam et
    console.log('[RateLimiter] Config service not available, using defaults.');
  }
}

// =========================================================================
// Rate Limit Middleware
// =========================================================================

/**
 * Gelen isteği tiered rate limit kontrolünden geçirir.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} - İstek kabul edildiyse true, engellendiyse false
 */
async function rateLimitMiddleware(req, res) {
  const ipHash = getHashedClientIP(req);
  const method = (req.method || 'GET').toUpperCase();
  const path = (req.pathname || (req.url || '').split('?')[0]);

  // -----------------------------------------------------------------------
  // 1. Banned IP kontrolü (PG, hash'li) — tüm istekler için
  // -----------------------------------------------------------------------
  const banned = await isIPBanned(ipHash);
  if (banned) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Access denied. Your IP address has been banned.' }));
    return false;
  }

  // -----------------------------------------------------------------------
  // 2. Bucket belirle
  // -----------------------------------------------------------------------
  const bucketName = resolveBucket(method, path);
  const bucket = BUCKETS[bucketName];

  // Admin bucket → muaf (JWT zaten koruyor)
  if (bucket.limit === Infinity) {
    return true;
  }

  // read bucket için config'den gelen override değerlerini kullan
  const limit = bucketName === 'read' ? readLimit : bucket.limit;
  const windowMinutes = bucketName === 'read' ? readWindowMinutes : bucket.windowMinutes;

  // -----------------------------------------------------------------------
  // 3. Sliding window kontrolü (in-memory, ipHash:bucket key ile)
  // -----------------------------------------------------------------------
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const mapKey = `${ipHash}:${bucketName}`;

  let record = rateLimitMap.get(mapKey);

  if (!record || (now - record.windowStart) > windowMs) {
    // Yeni pencere başlat
    record = { count: 1, windowStart: now };
    rateLimitMap.set(mapKey, record);
    return true;
  }

  // Mevcut pencere içinde
  record.count++;

  if (record.count > limit) {
    // Limit aşıldı
    const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
    console.warn(`[RateLimiter] 429 ${bucketName} bucket blocked: ${method} ${path} count=${record.count}/${limit} retryAfter=${retryAfter}s`);
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: 'Too many requests. Please try again later.',
      retry_after_seconds: retryAfter,
      bucket: bucketName,
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
 * Her 5 dakikada bir çalışır. Tüm bucket'lar için en uzun pencereyi baz alır.
 */
setInterval(() => {
  const now = Date.now();
  // En uzun pencere = login (15dk) — güvenli tarafta kal
  const maxWindowMs = 15 * 60 * 1000;

  for (const [key, record] of rateLimitMap.entries()) {
    if ((now - record.windowStart) > maxWindowMs) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// =========================================================================
// Export
// =========================================================================

module.exports = { rateLimitMiddleware, loadConfig, resolveBucket };
