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
 *   POST   /api/bundles/:id/download → bundle dosyalarını zip stream (şifresiz bundle'lar)
 */

const { pipeline } = require('node:stream');
const { addRoute, sendJSON, sendError, serveStaticFile } = require('../server');
const { getConfig } = require('../services/config-service');
const { createZipStream } = require('../services/zip-writer');
const storage = require('../services/storage');
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
// POST /api/bundles/:id/download — Bundle Dosyalarını Zip Stream
// =========================================================================
// Tüm dosyaları (veya file_ids ile alt kümesini) tek bir .zip olarak stream eder.
// STORE method (sıkıştırma yok) — media zaten sıkıştırılmış, CPU boşa harcanmaz.
//
// Kısıtlar:
//   - Şifreli bundle (is_encrypted) → 400. Zip server-side birleşik ciphertext
//     üretir; client tek tek dosyaları decrypt edip indirmeli (receiver page).
//   - Boş seçim (file_ids verilip hiçbiri eşleşmezse) → 400.
//
// Akış: her dosyayı KENDİ backend'inden stream → createZipStream(entries) → res.
// pipeline backpressure + cleanup yönetir; ERR_STREAM_PREMATURE_CLOSE (client erken
// kapattı) sessizce yutulur, diğer hatalar loglanır + res destroy edilir.
//
// Rate-limit: middleware/rate-limiter.js bu POST'u 'download' bucket'ına yönlendirir
// (ağır indirme, generic read limit'i değil).

addRoute('POST', '/api/bundles/:id/download', async (req, res, params, body) => {
  if (!UUID_RE.test(params.id)) return sendError(res, 400, 'Invalid bundle ID');

  let payload = {};
  try { payload = typeof body === 'string' ? JSON.parse(body) : (body || {}); }
  catch { /* boş/invalid body = tüm dosyalar */ }

  const bundle = await getBundle(params.id);
  if (!bundle) return sendError(res, 404, 'Bundle not found');
  if (bundle.expired) return sendError(res, 410, 'Bundle has expired');
  if (bundle.is_encrypted) {
    return sendError(res, 400, 'Zip download is not available for password-protected bundles. Download files individually.');
  }

  // file_ids verilmişse alt küme, yoksa tüm dosyalar.
  const want = Array.isArray(payload.file_ids) ? new Set(payload.file_ids) : null;
  const files = bundle.files.filter(f => !want || want.has(f.id));
  if (files.length === 0) return sendError(res, 400, 'No files selected');

  // Her dosyayı kendi backend'inden stream → zip entry. Dosya adı zip içinde
  // benzersiz olmalı (aynı isimde iki dosya → bazı extract'ler çakışır).
  const usedNames = new Set();
  const entries = [];
  for (const f of files) {
    if (!f.id || !f.storage_key) continue;
    try {
      const provider = await storage.getProviderForFile(f);
      const { stream } = await provider.getObjectStream(f.storage_key);
      // Dosya adını zip içinde benzersiz yap (duplicate → "name (2).ext").
      let name = f.filename || (f.id + '.bin');
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (usedNames.has(`${base} (${n})${ext}`)) n++;
        name = `${base} (${n})${ext}`;
      }
      usedNames.add(name);
      entries.push({ filename: name, stream });
    } catch (err) {
      console.error(`[Bundles] zip entry skipped (${f.id}):`, err.message);
    }
  }

  if (entries.length === 0) {
    return sendError(res, 500, 'No files could be read from storage');
  }

  const zip = createZipStream(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="bundle-${params.id.slice(0, 8)}.zip"`,
    'Cache-Control': 'no-store',
  });

  pipeline(zip, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[Bundles] zip stream error:', err.message);
      try { res.destroy(); } catch { /* already closed */ }
    }
  });
});

module.exports = {};
