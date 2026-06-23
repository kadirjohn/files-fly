/**
 * routes/bundles.js — Bundle API Route'ları
 *
 * Tek bir paylaşım linkiyle (/b/:bundleId) birden fazla dosyayı sunan bundle'lar.
 * Route'lar ince tutulur — iş mantığı bundle-service'te.
 *
 * Endpoint'ler:
 *   GET    /b/:id                   → receiver HTML sayfası (bundle.html statik)
 *   POST   /api/bundles             → boş bundle oluştur { bundle_id, password_salt }
 *   GET    /api/bundles/:id         → bundle metadata + dosya listesi (404/410)
 *   DELETE /api/bundles/:id         → bundle sil (sadece sahip, cascade files)
 *   GET    /api/session/bundles     → "Dosyalarım" — session'ın bundle'ları (sayfalı)
 *   POST   /api/bundles/:id/download → zip stream (Task 7'de uygulanır; şimdilik 501 stub)
 */

const { addRoute, sendJSON, sendError, serveStaticFile } = require('../server');
const { getConfig } = require('../services/config-service');
const {
  createBundle, getBundle, getMyBundles, deleteBundle, selectDecryptSalt,
} = require('../services/bundle-service');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =========================================================================
// GET /b/:id — Bundle Receiver Sayfası (HTML)
// =========================================================================
// bundle.html statik sayfasını sunar; bundle.js client-side /api/bundles/:id'den
// metadata çekip dosyaları render eder. /api/bundles/:id JSON döndürürken bu route
// kullanıcıya yönelik arayüzü sunar (file.html /files/:id ile aynı patern).

addRoute('GET', '/b/:id', async (req, res, params) => {
  if (!UUID_RE.test(params.id)) return sendError(res, 400, 'Invalid bundle ID');
  const served = serveStaticFile('/bundle.html', res);
  if (!served) sendError(res, 404, 'Bundle page not available');
});

// =========================================================================
// POST /api/bundles — Boş Bundle Oluştur
// =========================================================================
// Dosyaları yüklemeden ÖNCE bir bundle oluşturur (frontend batch akışı: önce
// bundle aç → her dosyayı bundle_id ile yükle). expireHours config'den max ile
// clamp'lenir (upload-service.handleUpload ile aynı getConfig kaynağı).

addRoute('POST', '/api/bundles', async (req, res, params, body) => {
  if (!req.sessionId) return sendError(res, 401, 'Session required');

  let payload = {};
  try {
    payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }

  const expireHours = parseInt(payload.expire, 10) || 1;

  // Expire sınırını config'den al (upload-service ile aynı kaynak — tutarlılık).
  let maxExpireHours = 48;
  try {
    const cfg = await getConfig('max_expire_hours');
    if (cfg) maxExpireHours = parseInt(cfg) || 48;
  } catch { /* config yoksa default 48 */ }

  if (expireHours < 1 || expireHours > maxExpireHours) {
    return sendError(res, 400, `Expire time must be between 1 and ${maxExpireHours} hours`);
  }

  try {
    const { id, passwordSalt } = await createBundle(req.sessionId, {
      expireHours,
      title: payload.title || null,
      password: payload.password || null,
    });
    sendJSON(res, 201, { bundle_id: id, password_salt: passwordSalt });
  } catch (err) {
    console.error('[Bundles] create error:', err.message);
    sendError(res, 500, 'Failed to create bundle');
  }
});

// =========================================================================
// GET /api/bundles/:id — Bundle Metadata + Dosya Listesi
// =========================================================================
// Receiver sayfası (bundle.js) bunu çeker. 404 = bulunamadı, 410 = süresi doldu.
// Her dosya için decrypt salt'ı selectDecryptSalt ile seç (bundle ortak salt varsa
// onu kullan → tek parola tüm dosyaları açar; yoksa per-file salt, legacy uyumu).

addRoute('GET', '/api/bundles/:id', async (req, res, params) => {
  if (!UUID_RE.test(params.id)) return sendError(res, 400, 'Invalid bundle ID');

  const bundle = await getBundle(params.id);
  if (!bundle) return sendError(res, 404, 'Bundle not found');
  if (bundle.expired) {
    return sendJSON(res, 410, { error: 'Bundle has expired', id: bundle.id, expired: true });
  }

  const files = bundle.files.map(f => ({
    id: f.id,
    filename: f.filename,
    file_size: f.file_size,
    mime_type: f.mime_type,
    is_encrypted: f.is_encrypted,
    encryption_iv: f.encryption_iv || null,
    encryption_salt: selectDecryptSalt(bundle, f), // bundle salt tercih, yoksa per-file
    download_count: f.download_count,
    created_at: f.created_at,
  }));

  sendJSON(res, 200, {
    id: bundle.id,
    title: bundle.title,
    file_count: bundle.file_count,
    total_size: bundle.total_size,
    expire_at: bundle.expire_at,
    is_encrypted: bundle.is_encrypted,
    password_salt: bundle.password_salt,
    created_at: bundle.created_at,
    expired: false,
    files,
  });
});

// =========================================================================
// DELETE /api/bundles/:id — Bundle Sil (Sahip)
// =========================================================================
// deleteBundle ownership kontrolü yapar (session_id eşleşmeli). Başarılı → 200,
// bulunamadı/sahip değil → 404. FK ON DELETE CASCADE files satırlarını kaldırır
// (NOT: storage blob'ları cascade ile SİLİNMEZ — caller blob temizliğini yönetir
// veya cleanup-job bundle.expire_at sweep eder).

addRoute('DELETE', '/api/bundles/:id', async (req, res, params) => {
  if (!req.sessionId) return sendError(res, 401, 'Session required');
  if (!UUID_RE.test(params.id)) return sendError(res, 400, 'Invalid bundle ID');

  const ok = await deleteBundle(params.id, req.sessionId);
  if (!ok) return sendError(res, 404, 'Bundle not found or not owned');

  sendJSON(res, 200, { deleted: true });
});

// =========================================================================
// GET /api/session/bundles — "Dosyalarım" (Session'ın Bundle'ları)
// =========================================================================
// Sayfalı: ?page=1&limit=20. getMyBundles limit'i 100'e clamp'ler.

addRoute('GET', '/api/session/bundles', async (req, res) => {
  if (!req.sessionId) return sendError(res, 401, 'Session required');

  const page = parseInt(req.query?.page, 10) || 1;
  const limit = parseInt(req.query?.limit, 10) || 20;

  const data = await getMyBundles(req.sessionId, { page, limit });
  sendJSON(res, 200, data);
});

// =========================================================================
// POST /api/bundles/:id/download — Zip Stream (Task 7'de uygulanır)
// =========================================================================
// Route burada stub olarak kayıtlı (route var olsun diye); Task 7 handler body'yi
// gerçek zip-stream implementasyonuyla değiştirir.

addRoute('POST', '/api/bundles/:id/download', async (req, res, params, body) => {
  sendError(res, 501, 'Zip download not yet implemented');
});

module.exports = {};
