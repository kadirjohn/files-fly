/**
 * ip-service.js — IP Adresi Gizlilik ve Güvenlik Servisi
 *
 * IP adreslerini plaintext saklamak yerine SHA-256 HMAC ile hash'ler.
 *
 * NOT: isIPBanned() hash'li IP kabul eder (rate-limiter'dan çağrılırken).
 *      banIP()/unbanIP() plaintext IP kabul eder (admin panelden çağrılırken).
 */

const crypto = require('crypto');
const { query } = require('./database');

// =========================================================================
// Yapılandırma
// =========================================================================

/**
 * IP hash'leme için secret key.
 * Environment variable'dan alınır, yoksa sunucu başlangıcında random oluşturulur.
 * Bu secret değişirse tüm hash'ler değişir — eski ban kayıtları geçersiz olur.
 */
let IP_HASH_SECRET = process.env.IP_HASH_SECRET || null;

/**
 * Secret'ı başlatır. Eğer env var'da yoksa random 64-byte secret oluşturur.
 * Bu, sunucu restart'ta değişir — production'da env var ile sabitlenmeli.
 */
function initIPSecret() {
  if (!IP_HASH_SECRET) {
    IP_HASH_SECRET = crypto.randomBytes(64).toString('base64');
    console.log('[IP] Generated random IP hash secret (will change on restart).');
    console.log('[IP] Set IP_HASH_SECRET env var for persistence across restarts.');
  } else {
    console.log('[IP] Using IP hash secret from environment variable.');
  }
}

// =========================================================================
// IP Hash'leme
// =========================================================================

/**
 * IP adresini SHA-256 HMAC ile hash'ler.
 * Aynı IP + aynı secret = aynı hash (deterministik).
 * Secret değişirse hash değişir.
 * 
 * @param {string} ip - IP adresi (örn: 192.168.1.5, ::1, 2001:db8::1)
 * @returns {string} - 64 karakter hex hash
 */
function hashIP(ip) {
  if (!ip) return 'unknown';
  if (!IP_HASH_SECRET) initIPSecret();

  const hmac = crypto.createHmac('sha256', IP_HASH_SECRET);
  hmac.update(normalizeIP(ip));
  return hmac.digest('hex');
}

/**
 * IP adresini normalize eder (IPv6 mapping, loopback, etc.).
 * @param {string} ip
 * @returns {string}
 */
function normalizeIP(ip) {
  // IPv4-mapped IPv6: ::ffff:192.0.2.1 → 192.0.2.1
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }

  // IPv6 loopback: ::1 → standart format
  if (ip === '::1') return '::1';

  // Zaten temiz IPv4 veya IPv6
  return ip.trim().toLowerCase();
}

// =========================================================================
// IP Adresi Tespiti
// =========================================================================

/**
 * İstekten gerçek istemci IP adresini alır.
 * Proxy arkasında çalışıyorsa X-Forwarded-For header'ına bakar.
 * 
 * @param {http.IncomingMessage} req
 * @returns {string} - IP adresi (plaintext, hash'lenmeden önce)
 */
function getClientIP(req) {
  // X-Forwarded-For (proxy arkası)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // İlk IP gerçek istemci IP'sidir
    return forwarded.split(',')[0].trim();
  }

  // X-Real-IP (bazı proxy'ler)
  const realIP = req.headers['x-real-ip'];
  if (realIP) {
    return realIP.trim();
  }

  // Direkt bağlantı
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * İstekten hash'lenmiş IP adresini alır.
 * @param {http.IncomingMessage} req
 * @returns {string} - 64 karakter hex hash
 */
function getHashedClientIP(req) {
  return hashIP(getClientIP(req));
}

// =========================================================================
// IP Ban Yönetimi
// =========================================================================

/**
 * Hash'lenmiş IP'nin banned_ips tablosunda olup olmadığını kontrol eder.
 * Süresi dolmuş ban'ları otomatik temizler.
 *
 * @param {string} ipHash - SHA-256 HMAC hash'lenmiş IP
 * @returns {Promise<boolean>} - Yasaklıysa true
 */
async function isIPBanned(ipHash) {
  try {
    // Süresi dolmamış ban kaydı var mı?
    const result = await query(
      `SELECT 1 FROM banned_ips
       WHERE ip_hash = $1
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [ipHash]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error('[IP] Error checking banned IP:', err.message);
    return false; // Hata durumunda fail-open (erişime izin ver)
  }
}

/**
 * IP'yi banlar.
 * @param {string} ip - Plaintext IP adresi
 * @param {string} reason - Ban sebebi
 * @param {string} bannedBy - Ban'layan admin kullanıcı adı
 * @param {number|null} durationHours - Ban süresi (saat), null = kalıcı
 * @returns {Promise<Object>}
 */
async function banIP(ip, reason, bannedBy, durationHours = null) {
  const hashedIP = hashIP(ip);

  const expiresAt = durationHours
    ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
    : null;

  await query(
    `INSERT INTO banned_ips (ip_hash, reason, banned_by, banned_at, expires_at)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (ip_hash) DO UPDATE 
     SET reason = $2, banned_by = $3, banned_at = NOW(), expires_at = $4`,
    [hashedIP, reason, bannedBy, expiresAt]
  );

  return { banned: true, ip_hash: hashedIP, expires_at: expiresAt };
}

/**
 * IP ban'ını kaldırır (plaintext IP ile).
 * @param {string} ip - Plaintext IP adresi
 * @returns {Promise<boolean>}
 */
async function unbanIP(ip) {
  const hashedIP = hashIP(ip);

  const result = await query(
    `DELETE FROM banned_ips WHERE ip_hash = $1`,
    [hashedIP]
  );

  return result.rowCount > 0;
}

/**
 * IP ban'ını hash ile kaldırır (admin panel için).
 * @param {string} ipHash - SHA-256 HMAC hash'lenmiş IP
 * @returns {Promise<boolean>}
 */
async function unbanIPByHash(ipHash) {
  const result = await query(
    `DELETE FROM banned_ips WHERE ip_hash = $1`,
    [ipHash]
  );

  return result.rowCount > 0;
}

/**
 * Tüm ban kayıtlarını listeler.
 * Admin panel için — hash'leri döndürür (plaintext IP'leri değil).
 * @returns {Promise<Array>}
 */
async function listBannedIPs() {
  const result = await query(
    `SELECT ip_hash, reason, banned_at, banned_by, expires_at
     FROM banned_ips
     WHERE expires_at IS NULL OR expires_at > NOW()
     ORDER BY banned_at DESC`
  );

  return result.rows;
}

// =========================================================================
// Periyodik Ban Temizliği
// =========================================================================

/**
 * Süresi dolmuş ban kayıtlarını temizler.
 * Her 30 dakikada bir otomatik çalışır.
 */
async function cleanupExpiredBans() {
  try {
    const result = await query(
      `DELETE FROM banned_ips WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    if (result.rowCount > 0) {
      console.log(`[IP] Cleaned up ${result.rowCount} expired ban(s).`);
    }
  } catch (err) {
    console.error('[IP] Error cleaning expired bans:', err.message);
  }
}

// 30 dakikada bir temizlik
setInterval(cleanupExpiredBans, 30 * 60 * 1000);

// =========================================================================
// Export
// =========================================================================

module.exports = {
  initIPSecret,
  hashIP,
  normalizeIP,
  getClientIP,
  getHashedClientIP,
  isIPBanned,
  banIP,
  unbanIP,
  unbanIPByHash,
  listBannedIPs,
  cleanupExpiredBans,
};
