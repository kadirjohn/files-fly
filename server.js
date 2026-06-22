/**
 * server.js — Files Fly Ana Sunucu
 *
 * Node.js built-in `http` modülü ile sıfır bağımlılık HTTP sunucu.
 *
 * Özellikler:
 * - Statik dosya sunumu (public/ dizini)
 * - Güvenlik header'ları (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
 * - Directory traversal koruması
 * - API Router (URL pattern matching, GET/POST/PUT/DELETE, JSON body parser)
 * - Middleware zinciri (rate-limiter → session → auth → router)
 * - IP hash'leme (privacy-first, KVKK uyumlu)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Middleware references — set in start() after DB is ready
let rateLimitMiddleware = null;
let sessionMiddleware = null;

// =========================================================================
// Yapılandırma
// =========================================================================

const PORT = process.env.PORT || 9392;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || 'development';

// =========================================================================
// MIME Type Haritası
// =========================================================================

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// =========================================================================
// Güvenlik Header'ları
// =========================================================================

/**
 * Tüm response'lara eklenen güvenlik header'ları.
 * Production'da HSTS aktif, development'ta pasif.
 */
function setSecurityHeaders(res) {
  // CSP: Dış kaynaklara kontrollü izin
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://unpkg.com https://cdnjs.cloudflare.com; " +
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "media-src 'self'; " +
    "frame-ancestors 'none';"
  );

  // MIME type sniffing koruması
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Clickjacking koruması
  res.setHeader('X-Frame-Options', 'DENY');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // HSTS (sadece production'da)
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // XSS koruması (eski tarayıcılar için)
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

// =========================================================================
// Statik Dosya Sunucusu
// =========================================================================

/**
 * public/ dizininden statik dosya sunar.
 * Directory traversal koruması: istenen path'in public/ içinde kaldığını kontrol eder.
 * 
 * @param {string} urlPath - İstenen URL path'i (örn: /css/style.css)
 * @param {http.ServerResponse} res 
 * @returns {boolean} - Dosya bulunup sunulduysa true
 */
function serveStaticFile(urlPath, res) {
  // Güvenlik: path traversal saldırılarını engelle
  // normalize + resolve ile gerçek path'i bul, public/ içinde mi kontrol et
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // Directory traversal kontrolü: çözümlenen path public/ ile başlamalı
  const resolvedPath = path.resolve(filePath);
  const resolvedPublic = path.resolve(PUBLIC_DIR);
  if (!resolvedPath.startsWith(resolvedPublic + path.sep) && resolvedPath !== resolvedPublic) {
    return false; // Erişim reddedildi
  }

  // Dosya var mı?
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  // MIME type belirle
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  // Dosyayı oku ve sun
  try {
    const content = fs.readFileSync(filePath);
    // HTML ve JS/CSS için no-cache (güncellemelerin her zaman yüklenmesi için).
    // Sadece immutable asset'ler (favicon, font, image) cache'lenir.
    const noCacheExt = ['.html', '.js', '.css'];
    const cacheControl = noCacheExt.includes(ext)
      ? 'no-cache, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': content.length,
      'Cache-Control': cacheControl,
    });
    res.end(content);
    return true;
  } catch (err) {
    console.error(`[Static] Error serving ${filePath}:`, err.message);
    return false;
  }
}

// =========================================================================
// API Router
// =========================================================================

/**
 * Route tanımı: { method, pattern, handler }
 * 
 * pattern: '/api/upload' gibi sabit veya '/api/files/:id' gibi parametreli
 * handler: async (req, res, params, body) => void
 *   - params: URL'den çıkarılan parametreler (örn: { id: 'abc-123' })
 *   - body: POST/PUT isteklerinde parse edilmiş JSON body
 */
const routes = [];

/**
 * Yeni route kaydeder.
 * @param {string} method - GET, POST, PUT, DELETE
 * @param {string} pattern - '/api/files/:id' formatında (parametreler :param)
 * @param {Function} handler - async (req, res, params, body) => {}
 */
function addRoute(method, pattern, handler) {
  // Pattern'i regex'e çevir: /api/files/:id → ^/api/files/([^/]+)$
  const paramNames = [];
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Regex özel karakterlerini escape et
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ method: method.toUpperCase(), pattern, regex, paramNames, handler });
}

/**
 * Gelen isteği route'larla eşleştirir ve handler'ı çağırır.
 * @returns {boolean} - Route bulunup işlendiyse true
 */
async function handleRoute(req, res, urlPath) {
  const method = req.method.toUpperCase();

  for (const route of routes) {
    if (route.method !== method) continue;

    const match = urlPath.match(route.regex);
    if (!match) continue;

    // Parametreleri çıkar
    const params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    // POST/PUT body'sini parse et
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      body = await parseBody(req);
    }

    // Handler'ı çağır
    try {
      await route.handler(req, res, params, body);
    } catch (err) {
      console.error(`[Route] Error in ${method} ${urlPath}:`, err);
      sendJSON(res, 500, { error: 'Internal server error' });
    }
    return true;
  }

  return false; // Route bulunamadı
}

// =========================================================================
// Body Parser (JSON + FormData)
// =========================================================================

/**
 * İstek body'sini okur.
 * Content-Type'a göre JSON veya raw string olarak parse eder.
 * 
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object|string|null>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0');

    // Hard body size limit: 110MB (100MB file + multipart overhead)
    const MAX_BODY = 110 * 1024 * 1024;
    if (contentLength > MAX_BODY) {
      resolve(null);
      return;
    }

    // For multipart uploads, buffer the entire body so parseMultipart can work on it.
    if (contentType.includes('multipart/form-data')) {
      const chunks = [];
      let totalSize = 0;
      let resolved = false;

      const done = (value) => {
        if (!resolved) { resolved = true; resolve(value); }
      };

      req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY) {
          // Drain remaining data without buffering, resolve null
          req.resume();
          done(null);
          return;
        }
        if (!resolved) chunks.push(chunk);
      });

      req.on('end', () => {
        if (resolved) return;
        if (totalSize === 0) { done(null); return; }
        done(Buffer.concat(chunks));
      });

      req.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
      });
      return;
    }

    // For JSON and other bodies, read normally
    const chunks = [];
    let totalSize = 0;

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY) {
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (totalSize === 0) {
        resolve(null);
        return;
      }

      const raw = Buffer.concat(chunks);

      if (contentType.includes('application/json')) {
        try {
          resolve(JSON.parse(raw.toString('utf-8')));
        } catch (err) {
          resolve(null);
        }
        return;
      }

      resolve(raw.toString('utf-8'));
    });

    req.on('error', reject);
  });
}

// =========================================================================
// Yardımcı Fonksiyonlar
// =========================================================================

/**
 * JSON response gönderir.
 */
function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Hata response'u gönderir.
 */
function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

/**
 * URL'den query string'i ayrıştırır.
 * @returns {Object} - { path: '/api/files', query: { page: '1', limit: '20' } }
 */
function parseURL(rawUrl) {
  const [pathPart, queryPart] = rawUrl.split('?', 2);
  const query = {};

  if (queryPart) {
    queryPart.split('&').forEach(pair => {
      const [key, val] = pair.split('=', 2);
      if (key) {
        query[decodeURIComponent(key)] = val ? decodeURIComponent(val) : '';
      }
    });
  }

  return { path: pathPart, query };
}

// =========================================================================
// Ana HTTP Sunucu
// =========================================================================

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();

  // Handle Expect: 100-continue (Node.js doesn't do this automatically)
  if (req.headers.expect === '100-continue') {
    res.writeContinue();
  }

  // Güvenlik header'larını her response'a ekle
  setSecurityHeaders(res);

  // URL'i parse et
  const { path: urlPath, query } = parseURL(req.url || '/');

  // İsteği req objesine query'yi ekle (middleware'ler için)
  req.query = query;
  req.pathname = urlPath;

  // Request log: response bitince logla (status kodu için)
  res.on('finish', () => {
    const ms = Date.now() - startTime;
    const status = res.statusCode;
    const isApi = urlPath.startsWith('/api/');
    const isError = status >= 400;

    // Production: sadece API isteklerini ve hataları logla
    // Development: her şeyi logla
    if (NODE_ENV === 'development' || isApi || isError) {
      const statusIcon = status >= 500 ? '💥' : status >= 400 ? '⚠️' : status >= 300 ? '↩️' : '✅';
      console.log(`${statusIcon} ${req.method} ${urlPath} → ${status} (${ms}ms)`);
    }
  });

  // -----------------------------------------------------------------------
  // Middleware Zinciri: Rate Limiter → Session → Router
  // -----------------------------------------------------------------------

  // 1. Rate Limiter — tiered bucket mimarisi (admin muaf, login/upload/download/read ayrı)
  //    Sadece /api/ route'larına uygulanır; statik dosyalar sayılmaz.
  if (urlPath.startsWith('/api/')) {
    try {
      const rateLimited = await rateLimitMiddleware(req, res);
      if (!rateLimited) return;
    } catch (err) {
      console.error('[Server] Rate limiter error:', err.message);
      // Rate limiter hatasında fail-open (erişime izin ver)
    }
  }

  // 2. Session — Cookie-based kullanıcı oturumu (her istekte)
  try {
    await sessionMiddleware(req, res);
  } catch (err) {
    console.error('[Server] Session middleware error:', err.message);
    // Session hatasında devam et (sessionId null olabilir)
  }

  // -----------------------------------------------------------------------
  // 3. API Route'ları dene
  // -----------------------------------------------------------------------
  const routeHandled = await handleRoute(req, res, urlPath);
  if (routeHandled) return;

  // -----------------------------------------------------------------------
  // 4. Statik dosya sunmayı dene
  // -----------------------------------------------------------------------
  // GET istekleri için public/ dizininden statik dosya ara
  if (req.method === 'GET' || req.method === 'HEAD') {
    // Kök path → index.html
    const staticPath = urlPath === '/' ? '/index.html' : urlPath;

    if (serveStaticFile(staticPath, res)) {
      return;
    }

    // SPA fallback: HTML sayfaları için index.html'e yönlendir
    // (admin.html, session.html gibi)
    if (!path.extname(staticPath)) {
      const htmlPath = staticPath + '.html';
      if (serveStaticFile(htmlPath, res)) {
        return;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 5. 404 — Hiçbir şey eşleşmedi
  // -----------------------------------------------------------------------
  sendError(res, 404, 'Not found');
});

// =========================================================================
// Sunucu Başlatma
// =========================================================================

/**
 * Veritabanını başlatır ve sunucuyu dinlemeye başlar.
 */
async function start() {
  // IP hash servisini başlat
  try {
    const { initIPSecret } = require('./services/ip-service');
    initIPSecret();
  } catch (err) {
    console.error('[Server] IP service initialization failed:', err.message);
  }

  // Veritabanı bağlantısı ve migration'lar
  try {
    const { initDatabase } = require('./services/database');
    await initDatabase();
  } catch (err) {
    console.error('[Server] Database initialization failed:', err.message);
    console.error('[Server] Starting without database — some features will be unavailable.');
  }

  // Middleware'leri yükle (DB hazır olduktan sonra)
  try {
    const rl = require('./middleware/rate-limiter');
    const sm = require('./middleware/session');
    rateLimitMiddleware = rl.rateLimitMiddleware;
    sessionMiddleware = sm.sessionMiddleware;
    console.log('[Server] Middleware loaded.');
  } catch (err) {
    console.error('[Server] Error loading middleware:', err.message);
  }

  // Route'ları yükle (her route modülü kendini register eder)
  try {
    require('./routes/session');
    require('./routes/upload');
    require('./routes/files');
    require('./routes/admin');
    console.log('[Server] Routes loaded.');
  } catch (err) {
    console.error('[Server] Error loading routes:', err.message);
  }

  // Cleanup cron job'unu başlat
  try {
    const { startCleanupJob } = require('./services/cleanup-job');
    await startCleanupJob();
  } catch (err) {
    console.error('[Server] Cleanup job failed to start:', err.message);
  }

  // Dinlemeye başla
  server.listen(PORT, HOST, () => {
    console.log(`[Server] Files Fly running at http://${HOST}:${PORT}`);
    console.log(`[Server] Environment: ${NODE_ENV}`);
    console.log(`[Server] Public dir: ${PUBLIC_DIR}`);
    console.log(`[Server] Uploads dir: ${UPLOADS_DIR}`);
  });
}

// Hata yönetimi
server.on('error', (err) => {
  console.error('[Server] Fatal error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('[Server] Closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  server.close(() => {
    console.log('[Server] Closed.');
    process.exit(0);
  });
});

// =========================================================================
// Export'lar (diğer modüller için)
// =========================================================================

module.exports = {
  server,
  addRoute,
  sendJSON,
  sendError,
  parseURL,
  parseBody,
  serveStaticFile,
  PUBLIC_DIR,
  UPLOADS_DIR,
  BASE_URL,
  PORT,
};

// Doğrudan çalıştırılıyorsa başlat
if (require.main === module) {
  start();
}
