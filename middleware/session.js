/**
 * session.js — Cookie-based Kullanıcı Oturumu Middleware
 *
 * Her ziyaretçiye UUID session ID atar, HttpOnly/Secure/SameSite cookie ile saklar.
 * Session'lar PostgreSQL `sessions` tablosunda tutulur.
 * IP adresleri SHA-256 HMAC ile hash'lenerek saklanır (privacy).
 *
 * Middleware olarak: gelen istekte session cookie'sini okur, yoksa yeni session oluşturur.
 * Route handler olarak: POST /api/session, GET /api/session/files endpoint'leri.
 */

const crypto = require('crypto');
const { query } = require('../services/database');
const { addRoute, sendJSON, sendError } = require('../server');
const { getClientIP, getHashedClientIP } = require('../services/ip-service');

// =========================================================================
// Yapılandırma
// =========================================================================

const COOKIE_NAME = 'filesfly_sid';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 gün (ms)
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'Strict',
  path: '/',
  maxAge: SESSION_MAX_AGE,
};

// =========================================================================
// Session Middleware
// =========================================================================

/**
 * Gelen istekte session cookie'sini okur, session'ı doğrular.
 * Yoksa yeni session oluşturur ve cookie set eder.
 * 
 * req.session = { id, ip_address, user_agent, created_at, last_seen }
 * 
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} - Her zaman true (session her zaman oluşturulur)
 */
async function sessionMiddleware(req, res) {
  // Cookie'den session ID'yi oku
  const sessionId = getCookie(req, COOKIE_NAME);

  if (sessionId && isValidUUID(sessionId)) {
    // Mevcut session'ı doğrula ve güncelle
    const existing = await getSession(sessionId);

    if (existing) {
      // Session var → last_seen güncelle
      await updateSessionLastSeen(sessionId);
      req.session = existing;
      req.sessionId = sessionId;
      return true;
    }
  }

  // Yeni session oluştur
  const newSession = await createSession(req);
  req.session = newSession;
  req.sessionId = newSession.id;

  // Cookie set et
  setSessionCookie(res, newSession.id);

  return true;
}

// =========================================================================
// Cookie Yardımcıları
// =========================================================================

/**
 * İstek header'ından cookie değerini okur.
 * @param {http.IncomingMessage} req
 * @param {string} name - Cookie adı
 * @returns {string|null}
 */
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, ...valParts] = cookie.split('=');
    if (key === name) {
      return decodeURIComponent(valParts.join('='));
    }
  }
  return null;
}

/**
 * Response'a session cookie'si set eder.
 * @param {http.ServerResponse} res
 * @param {string} sessionId
 */
function setSessionCookie(res, sessionId) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    `Path=${COOKIE_OPTIONS.path}`,
    `Max-Age=${Math.floor(COOKIE_OPTIONS.maxAge / 1000)}`,
    `SameSite=${COOKIE_OPTIONS.sameSite}`,
  ];

  if (COOKIE_OPTIONS.httpOnly) parts.push('HttpOnly');
  if (COOKIE_OPTIONS.secure) parts.push('Secure');

  res.setHeader('Set-Cookie', parts.join('; '));
}

// =========================================================================
// Session Veritabanı İşlemleri
// =========================================================================

/**
 * Yeni session oluşturur (PG'ye kaydeder).
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object>} - Session objesi
 */
async function createSession(req) {
  const id = crypto.randomUUID();
  const ipHash = getHashedClientIP(req);
  const userAgent = req.headers['user-agent'] || null;

  const result = await query(
    `INSERT INTO sessions (id, ip_hash, user_agent)
     VALUES ($1, $2, $3)
     RETURNING id, ip_hash, user_agent, created_at, last_seen`,
    [id, ipHash, userAgent]
  );

  return result.rows[0];
}

/**
 * Session ID'ye göre session'ı getirir.
 * @param {string} sessionId
 * @returns {Promise<Object|null>}
 */
async function getSession(sessionId) {
  const result = await query(
    `SELECT id, ip_hash, user_agent, created_at, last_seen
     FROM sessions WHERE id = $1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

/**
 * Session'ın last_seen alanını günceller.
 * @param {string} sessionId
 */
async function updateSessionLastSeen(sessionId) {
  await query(
    `UPDATE sessions SET last_seen = NOW() WHERE id = $1`,
    [sessionId]
  );
}

/**
 * Basit UUID format validasyonu.
 * @param {string} str
 * @returns {boolean}
 */
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// =========================================================================
// Route: POST /api/session — Yeni session oluştur (veya mevcut'u döndür)
// =========================================================================

addRoute('POST', '/api/session', async (req, res, params, body) => {
  // Session zaten middleware tarafından oluşturuldu
  // Sadece session bilgisini döndür
  if (!req.session) {
    // Middleware atlanmışsa manuel oluştur
    const session = await createSession(req);
    setSessionCookie(res, session.id);
    req.session = session;
    req.sessionId = session.id;
  }

  sendJSON(res, 200, {
    session_id: req.sessionId,
    created_at: req.session.created_at,
    last_seen: req.session.last_seen,
  });
});

// =========================================================================
// Route: GET /api/session/files — Kullanıcının kendi dosyaları
// =========================================================================

addRoute('GET', '/api/session/files', async (req, res, params, body) => {
  if (!req.sessionId) {
    return sendError(res, 401, 'Session required');
  }

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;

  // Toplam dosya sayısı
  const countResult = await query(
    `SELECT COUNT(*) as total FROM files WHERE session_id = $1`,
    [req.sessionId]
  );
  const total = parseInt(countResult.rows[0].total);

  // Dosyaları getir
  const filesResult = await query(
    `SELECT id, filename, file_size, mime_type, direct_url, expire_at,
            is_encrypted, created_at, download_count
     FROM files
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.sessionId, limit, offset]
  );

  sendJSON(res, 200, {
    files: filesResult.rows,
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// =========================================================================
// Export
// =========================================================================

module.exports = { sessionMiddleware, getCookie, setSessionCookie };
