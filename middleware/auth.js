/**
 * auth.js — Admin JWT Authentication Middleware
 * 
 * Zero-dependency JWT: Node.js built-in `crypto` ile HMAC-SHA256.
 * Parola hash: `crypto.scrypt` ile salt:hash formatı.
 * 
 * Endpoint'ler:
 * - POST /api/admin/login  → JWT token döndürür
 * - Admin JWT verify middleware
 */

const crypto = require('crypto');
const { query } = require('../services/database');
const { addRoute, sendJSON, sendError } = require('../server');

// =========================================================================
// Yapılandırma
// =========================================================================

const JWT_SECRET = process.env.JWT_SECRET || 'changeme-in-production';
const JWT_EXPIRY_HOURS = 24; // Token 24 saat geçerli

// =========================================================================
// scrypt Parola Hash
// =========================================================================

/**
 * Parolayı crypto.scrypt ile hash'ler.
 * Format: base64salt:base64hash (salt ve hash : ile ayrılır)
 * 
 * @param {string} password - Plaintext parola
 * @returns {Promise<string>} - salt:hash formatında
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('base64');

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString('base64')}`);
    });
  });
}

/**
 * Parolayı hash ile karşılaştırır.
 * 
 * @param {string} password - Plaintext parola
 * @param {string} storedHash - salt:hash formatında saklanan hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString('base64') === hash);
    });
  });
}

// =========================================================================
// JWT (Zero-Dependency HMAC-SHA256)
// =========================================================================

/**
 * JWT token oluşturur.
 * Header: { alg: "HS256", typ: "JWT" }
 * Payload: { sub: username, iat, exp }
 * 
 * @param {string} username - Admin kullanıcı adı
 * @returns {string} - JWT token
 */
function createJWT(username) {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: username,
    iat: now,
    exp: now + JWT_EXPIRY_HOURS * 60 * 60,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = signJWT(`${headerB64}.${payloadB64}`);

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * JWT token'ı doğrular ve payload'ı döndürür.
 * 
 * @param {string} token - JWT token
 * @returns {Object|null} - Payload veya null (geçersiz/süresi dolmuş)
 */
function verifyJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signature] = parts;

  // İmza kontrolü
  const expectedSig = signJWT(`${headerB64}.${payloadB64}`);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return null;
  }

  // Payload decode
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }

  // Expiry kontrolü
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return null; // Süresi dolmuş
  }

  return payload;
}

/**
 * JWT imzası oluşturur (HMAC-SHA256).
 */
function signJWT(data) {
  const hmac = crypto.createHmac('sha256', JWT_SECRET);
  hmac.update(data);
  return base64urlEncode(hmac.digest('base64'));
}

/**
 * Base64URL encode (JWT standardı).
 */
function base64urlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64URL decode.
 */
function base64urlDecode(str) {
  // Padding ekle
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf-8');
}

// =========================================================================
// Admin JWT Middleware
// =========================================================================

/**
 * İstekten JWT token'ı okur ve doğrular.
 * Authorization: Bearer <token> header'ından veya ?token= query param'dan.
 * 
 * req.adminUser = { username } — doğrulanmış admin bilgisi
 * 
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} - Doğrulandıysa true
 */
async function adminAuthMiddleware(req, res) {
  // Token'ı al
  let token = null;

  // Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  // Query param (fallback — admin panel fetch için)
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    sendError(res, 401, 'Authentication required');
    return false;
  }

  // Token'ı doğrula
  const payload = verifyJWT(token);
  if (!payload) {
    sendError(res, 401, 'Invalid or expired token');
    return false;
  }

  // Admin kullanıcısı hala var mı?
  const adminExists = await query(
    `SELECT 1 FROM admin_users WHERE username = $1`,
    [payload.sub]
  );

  if (adminExists.rows.length === 0) {
    sendError(res, 401, 'Admin user no longer exists');
    return false;
  }

  req.adminUser = { username: payload.sub };
  return true;
}

// =========================================================================
// Route: POST /api/admin/login
// =========================================================================

addRoute('POST', '/api/admin/login', async (req, res, params, body) => {
  if (!body || !body.username || !body.password) {
    return sendError(res, 400, 'Username and password required');
  }

  try {
    // Admin kullanıcısını bul
    const result = await query(
      `SELECT username, password_hash FROM admin_users WHERE username = $1`,
      [body.username]
    );

    if (result.rows.length === 0) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const admin = result.rows[0];

    // Parola doğrulama
    const valid = await verifyPassword(body.password, admin.password_hash);
    if (!valid) {
      return sendError(res, 401, 'Invalid credentials');
    }

    // JWT oluştur
    const token = createJWT(admin.username);

    sendJSON(res, 200, {
      token,
      username: admin.username,
      expires_in: JWT_EXPIRY_HOURS * 60 * 60,
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    sendError(res, 500, 'Login failed');
  }
});

// =========================================================================
// Admin Kullanıcı Yönetimi (Yardımcı)
// =========================================================================

/**
 * Yeni admin kullanıcısı oluşturur.
 * İlk kurulum için kullanılır.
 * 
 * @param {string} username
 * @param {string} password
 * @returns {Promise<Object>}
 */
async function createAdminUser(username, password) {
  const passwordHash = await hashPassword(password);

  await query(
    `INSERT INTO admin_users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
    [username, passwordHash]
  );

  return { username, created: true };
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  adminAuthMiddleware,
  createJWT,
  verifyJWT,
  hashPassword,
  verifyPassword,
  createAdminUser,
};
