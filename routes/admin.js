/**
 * routes/admin.js — Admin Route'ları
 * 
 * Tüm admin endpoint'leri:
 * - POST /api/admin/login          (auth.js'de)
 * - GET  /api/admin/stats          Dashboard istatistikleri
 * - GET  /api/admin/files          Dosya listesi (sayfalama, arama, filtre)
 * - GET  /api/admin/files/:id/preview  Dosya önizleme
 * - DELETE /api/admin/files/:id    Dosya silme
 * - GET  /api/admin/banned-ips     Yasaklı IP listesi
 * - POST /api/admin/ban-ip         IP yasakla
 * - DELETE /api/admin/ban-ip/:ip   IP yasak kaldır
 * - GET  /api/admin/config         Config listesi
 * - PUT  /api/admin/config         Config güncelleme
 */

const { addRoute, sendJSON, sendError } = require('../server');
const { adminAuthMiddleware } = require('../middleware/auth');
const { query } = require('../services/database');
const { getPreview, generateThumbnail } = require('../services/preview-service');
const { fileExists, readFileStream, getThumbPath, getThumbFailMarkerPath, deleteThumb } = require('../services/storage-service');
const storage = require('../services/storage');

// Thumbnail üretimi için kaynak dosya boyut limiti (preview-service ile aynı).
const THUMB_MAX_SRC_BYTES = 50 * 1024 * 1024; // 50MB
const { getAllConfig, updateConfig, invalidateCache } = require('../services/config-service');
const { banIP, unbanIP, unbanIPByHash, listBannedIPs } = require('../services/ip-service');

// =========================================================================
// Admin Middleware Wrapper
// =========================================================================

/**
 * Admin route'ları için auth kontrolü ekleyen wrapper.
 * addRoute ile aynı imza, ama handler'dan önce adminAuthMiddleware çalışır.
 */
function addAdminRoute(method, pattern, handler) {
  addRoute(method, pattern, async (req, res, params, body) => {
    const authed = await adminAuthMiddleware(req, res);
    if (!authed) return; // Auth middleware zaten error response gönderdi
    await handler(req, res, params, body);
  });
}

// =========================================================================
// GET /api/admin/stats — Dashboard İstatistikleri
// =========================================================================

addAdminRoute('GET', '/api/admin/stats', async (req, res, params, body) => {
  try {
    // Toplam dosya sayısı
    const totalResult = await query(`SELECT COUNT(*) as count FROM files`);
    const totalFiles = parseInt(totalResult.rows[0].count);

    // Aktif dosya sayısı (süresi dolmamış)
    const activeResult = await query(
      `SELECT COUNT(*) as count FROM files WHERE expire_at > NOW()`
    );
    const activeFiles = parseInt(activeResult.rows[0].count);

    // Toplam boyut
    const sizeResult = await query(
      `SELECT COALESCE(SUM(file_size), 0) as total FROM files WHERE expire_at > NOW()`
    );
    const totalSize = parseInt(sizeResult.rows[0].total);

    // Bugünkü yüklemeler
    const todayResult = await query(
      `SELECT COUNT(*) as count FROM files WHERE created_at >= CURRENT_DATE`
    );
    const todayUploads = parseInt(todayResult.rows[0].count);

    // Benzersiz session sayısı (son 7 gün)
    const sessionsResult = await query(
      `SELECT COUNT(DISTINCT session_id) as count FROM files WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    const uniqueSessions = parseInt(sessionsResult.rows[0].count);

    // Son 7 gün yükleme istatistiği
    const dailyResult = await query(
      `SELECT DATE(created_at) as day, COUNT(*) as count
       FROM files
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY day DESC`
    );

    sendJSON(res, 200, {
      total_files: totalFiles,
      active_files: activeFiles,
      total_size_bytes: totalSize,
      today_uploads: todayUploads,
      unique_sessions_7d: uniqueSessions,
      daily_stats: dailyResult.rows,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    sendError(res, 500, 'Failed to load statistics');
  }
});

// =========================================================================
// GET /api/admin/files — Dosya Listesi
// =========================================================================

addAdminRoute('GET', '/api/admin/files', async (req, res, params, body) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const mimeType = req.query.mime_type || '';
    const ipHash = req.query.ip_hash || '';

    // WHERE clause oluştur
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`filename ILIKE $${paramIndex}`);
      values.push(`%${search}%`);
      paramIndex++;
    }

    if (mimeType) {
      if (mimeType.endsWith('/*')) {
        const prefix = mimeType.replace('/*', '');
        conditions.push(`mime_type LIKE $${paramIndex}`);
        values.push(`${prefix}/%`);
      } else {
        conditions.push(`mime_type = $${paramIndex}`);
        values.push(mimeType);
      }
      paramIndex++;
    }

    if (ipHash) {
      conditions.push(`ip_hash = $${paramIndex}`);
      values.push(ipHash);
      paramIndex++;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Toplam sayı
    const countResult = await query(
      `SELECT COUNT(*) as total FROM files ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].total);

    // Dosyaları getir
    const filesResult = await query(
      `SELECT id, session_id, ip_hash, filename, file_size, mime_type,
              direct_url, expire_at, is_encrypted, created_at, download_count
       FROM files ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    sendJSON(res, 200, {
      files: filesResult.rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Admin] Files list error:', err.message);
    sendError(res, 500, 'Failed to load files');
  }
});

// =========================================================================
// GET /api/admin/files/:id/preview — Dosya Önizleme
// =========================================================================

addAdminRoute('GET', '/api/admin/files/:id/preview', async (req, res, params, body) => {
  try {
    const preview = await getPreview(params.id);
    sendJSON(res, 200, preview);
  } catch (err) {
    console.error('[Admin] Preview error:', err.message);
    sendError(res, 500, 'Failed to generate preview');
  }
});

// =========================================================================
// GET /api/admin/files/:id/preview-img — Image Thumbnail (streaming)
// =========================================================================
// sharp ile üretilmiş küçültülmüş JPEG thumbnail'ını stream eder.
// /data/thumbs/:id.jpg'de cache'lenir. Eğer yoksa anında üretilir.
// Admin panelinde <img src=".../preview-img"> ile yüklenir — base64 yerine.

addAdminRoute('GET', '/api/admin/files/:id/preview-img', async (req, res, params, body) => {
  try {
    const fileId = params.id;

    // Metadata'yı al (sadece image dosyaları için thumbnail)
    const result = await query(
      `SELECT id, filename, file_size, mime_type, storage_backend, storage_key, expire_at
       FROM files WHERE id = $1`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'File not found');
    }

    const file = result.rows[0];

    // Süresi dolmuş mu?
    if (new Date(file.expire_at) < new Date()) {
      return sendError(res, 410, 'File has expired');
    }

    // Sadece image/* için thumbnail — diğer türlere 400
    if (!file.mime_type || !file.mime_type.startsWith('image/')) {
      return sendError(res, 400, 'Thumbnail only available for images');
    }

    const thumbPath = getThumbPath(file.id);
    const failMarkerPath = getThumbFailMarkerPath(file.id);

    // Negative cache hit — daha önce üretim başarısız oldu (DoS önlemi).
    if (await fileExists(failMarkerPath)) {
      return sendError(res, 404, 'Thumbnail not available');
    }

    // RAM koruması: 50MB'den büyük imajlar için thumbnail üretme.
    if (file.file_size && file.file_size > THUMB_MAX_SRC_BYTES) {
      return sendError(res, 404, 'Thumbnail not available (source too large)');
    }

    // Thumbnail'ı üret/cache'den al (generateThumbnail negative cache marker yazar başarısız olursa)
    try {
      await generateThumbnail(file);
    } catch (genErr) {
      console.error('[Admin] Thumbnail generation failed:', genErr.message);
    }

    // Thumbnail diskte var mı kontrol et (sharp başarısız / negative cache / çok büyük)
    if (!(await fileExists(thumbPath))) {
      return sendError(res, 404, 'Thumbnail not available');
    }

    // Stream et
    const { stream, size } = await readFileStream(thumbPath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': size,
      'Cache-Control': 'public, max-age=86400', // 24 saat cache (değişmez)
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[Admin] Thumbnail error:', err.message);
    if (!res.headersSent) {
      sendError(res, 500, 'Failed to generate thumbnail');
    }
  }
});

// =========================================================================
// DELETE /api/admin/files/:id — Dosya Silme
// =========================================================================

addAdminRoute('DELETE', '/api/admin/files/:id', async (req, res, params, body) => {
  try {
    const fileId = params.id;

    // Metadata'yı al (storage_backend + storage_key — bucket mantığı)
    const result = await query(
      `SELECT id, storage_backend, storage_key, filename FROM files WHERE id = $1`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'File not found');
    }

    const file = result.rows[0];

    // Object Storage'dan sil (dosyanın KENDİ backend'ine göre — backend
    // değişse bile doğru yere silinir, orphan blob önlenir)
    if (file.storage_key) {
      try {
        const provider = await storage.getProviderForFile(file);
        await provider.deleteObject(file.storage_key);
      } catch (err) {
        console.error(`[Admin] Error deleting object ${file.storage_key} from ${file.storage_backend}:`, err.message);
        // Nesne silinmese bile DB kaydını sil (orphan blob uyarısı logla)
      }
    }

    // Thumbnail cache'ini de temizle (her zaman local disk)
    try {
      await deleteThumb(fileId);
    } catch (err) {
      // Thumbnail yoksa veya silinemezse kritik değil
    }

    // PG'den sil
    await query(`DELETE FROM files WHERE id = $1`, [fileId]);

    sendJSON(res, 200, { deleted: true, id: fileId, filename: file.filename });
  } catch (err) {
    console.error('[Admin] Delete error:', err.message);
    sendError(res, 500, 'Failed to delete file');
  }
});

// =========================================================================
// GET /api/admin/banned-ips — Yasaklı IP Listesi
// =========================================================================

addAdminRoute('GET', '/api/admin/banned-ips', async (req, res, params, body) => {
  try {
    const ips = await listBannedIPs();
    sendJSON(res, 200, { ips });
  } catch (err) {
    console.error('[Admin] Banned IPs error:', err.message);
    sendError(res, 500, 'Failed to load banned IPs');
  }
});

// =========================================================================
// POST /api/admin/ban-ip — IP Yasakla
// =========================================================================

addAdminRoute('POST', '/api/admin/ban-ip', async (req, res, params, body) => {
  if (!body || !body.ip_address) {
    return sendError(res, 400, 'ip_address is required');
  }

  try {
    const reason = body.reason || 'Manual ban';
    const durationHours = body.duration_hours ? parseInt(body.duration_hours) : null;
    const bannedBy = req.adminUser.username;

    const result = await banIP(body.ip_address, reason, bannedBy, durationHours);

    sendJSON(res, 200, {
      banned: true,
      ip_hash: result.ip_hash,
      reason,
      expires_at: result.expires_at,
    });
  } catch (err) {
    console.error('[Admin] Ban IP error:', err.message);
    sendError(res, 500, 'Failed to ban IP');
  }
});

// =========================================================================
// DELETE /api/admin/ban-ip/:ip — IP Yasak Kaldır (plaintext IP)
// =========================================================================

addAdminRoute('DELETE', '/api/admin/ban-ip/:ip', async (req, res, params, body) => {
  try {
    const ip = decodeURIComponent(params.ip);
    const removed = await unbanIP(ip);

    if (!removed) {
      return sendError(res, 404, 'IP not found in ban list');
    }

    sendJSON(res, 200, { unbanned: true });
  } catch (err) {
    console.error('[Admin] Unban IP error:', err.message);
    sendError(res, 500, 'Failed to unban IP');
  }
});

// =========================================================================
// DELETE /api/admin/ban-ip-hash/:hash — IP Yasak Kaldır (hash ile)
// =========================================================================

addAdminRoute('DELETE', '/api/admin/ban-ip-hash/:hash', async (req, res, params, body) => {
  try {
    const ipHash = decodeURIComponent(params.hash);
    const removed = await unbanIPByHash(ipHash);

    if (!removed) {
      return sendError(res, 404, 'IP hash not found in ban list');
    }

    sendJSON(res, 200, { unbanned: true });
  } catch (err) {
    console.error('[Admin] Unban IP by hash error:', err.message);
    sendError(res, 500, 'Failed to unban IP');
  }
});

// =========================================================================
// GET /api/admin/config — Config Listesi
// =========================================================================

// Public config endpoint (no auth — used by main page to read max_file_size_mb, chunk_size_mb)
addRoute('GET', '/api/admin/config', async (req, res, params, body) => {
  try {
    const config = await getAllConfig();
    sendJSON(res, 200, { config });
  } catch (err) {
    console.error('[Admin] Config error:', err.message);
    sendError(res, 500, 'Failed to load config');
  }
});

// =========================================================================
// PUT /api/admin/config — Config Güncelleme
// =========================================================================

addAdminRoute('PUT', '/api/admin/config', async (req, res, params, body) => {
  if (!body || Object.keys(body).length === 0) {
    return sendError(res, 400, 'No config values provided');
  }

  try {
    const updated = await updateConfig(body);
    invalidateCache(); // Tüm cache'i temizle

    // Eğer storage_backend güncellendiyse aktif provider'ı da set et
    if (body.storage_backend) {
      try {
        storage.setActiveBackend(body.storage_backend);
        console.log(`[Admin] Storage backend switched to: ${body.storage_backend}`);
      } catch (err) {
        console.error('[Admin] Failed to switch storage backend:', err.message);
      }
    }

    sendJSON(res, 200, { updated: true, keys_updated: updated });
  } catch (err) {
    console.error('[Admin] Config update error:', err.message);
    sendError(res, 500, 'Failed to update config');
  }
});

// =========================================================================
// GET /api/admin/storage/backends — Storage Backend Durum Raporu
// =========================================================================
// Admin paneldeki "Storage" ayar bölümü için: hangi backend'lerin
// kullanılabilir olduğu, hangisinin aktif olduğu, eksik credential/deps.

addAdminRoute('GET', '/api/admin/storage/backends', async (req, res, params, body) => {
  try {
    const statuses = await storage.getBackendStatuses();
    sendJSON(res, 200, {
      active_backend: storage.getActiveBackendName(),
      supported: storage.SUPPORTED_BACKENDS,
      backends: statuses,
    });
  } catch (err) {
    console.error('[Admin] Storage backends error:', err.message);
    sendError(res, 500, 'Failed to load storage backend status');
  }
});

// =========================================================================
// PUT /api/admin/storage/backend — Aktif Storage Backend Seç
// =========================================================================
// Body: { backend: 'local' | 'r2' | 'supabase' }
// Backend kullanılabilir değilse (credential/deps eksik) 400 döner.
// Sadece yeni dosyaları etkiler — mevcut dosyalar kendi backend'inde kalır.

addAdminRoute('PUT', '/api/admin/storage/backend', async (req, res, params, body) => {
  const backend = body && body.backend;

  if (!backend) {
    return sendError(res, 400, 'backend alanı gerekli');
  }

  if (!storage.SUPPORTED_BACKENDS.includes(backend)) {
    return sendError(res, 400, `Desteklenmeyen backend: ${backend}. Desteklenenler: ${storage.SUPPORTED_BACKENDS.join(', ')}`);
  }

  try {
    // Önce kullanılabilirlik kontrolü — credential/deps eksikse reddet
    const check = await storage.checkBackendAvailability(backend);
    if (!check.available) {
      let msg = `Backend "${backend}" kullanılamaz: ${check.error || 'bilinmeyen sebep'}`;
      if (check.missingDeps && check.missingDeps.length > 0) {
        msg += `. Eksik paketler: ${check.missingDeps.join(', ')}`;
      }
      return sendError(res, 400, msg);
    }

    // Provider'ı instantiate et (gerçek bağlantı testi)
    try {
      await storage.getProvider(backend);
    } catch (provErr) {
      return sendError(res, 400, `Backend "${backend}" başlatılamadı: ${provErr.message}`);
    }

    // Config'e yaz (kalıcı) + aktif backend'i set et (runtime)
    await updateConfig({ storage_backend: backend });
    invalidateCache();
    storage.setActiveBackend(backend);

    console.log(`[Admin] Storage backend switched to: ${backend} (by ${req.adminUser.username})`);
    sendJSON(res, 200, {
      active_backend: backend,
      message: `Yeni dosyalar artık "${backend}" backend'ine yüklenecek. Mevcut dosyalar kendi backend'inde kalır.`,
    });
  } catch (err) {
    console.error('[Admin] Storage backend switch error:', err.message);
    sendError(res, 500, 'Failed to switch storage backend');
  }
});

// =========================================================================
// GET /api/admin/storage/config/:backend — Backend Credential Görüntüle
// =========================================================================
// Bir backend'in config değerlerini döndürür. Secret alanlar MASKELİ
// (örn: "••••••••last4"), diğer alanlar düz metin. Boş alanlar null.
// Admin paneldeki credential formunu doldurur.

addAdminRoute('GET', '/api/admin/storage/config/:backend', async (req, res, params, body) => {
  const backend = params.backend;
  if (!storage.SUPPORTED_BACKENDS.includes(backend)) {
    return sendError(res, 400, `Desteklenmeyen backend: ${backend}`);
  }
  try {
    const cfg = await storage.getBackendConfig(backend);
    sendJSON(res, 200, cfg);
  } catch (err) {
    console.error('[Admin] Storage config GET error:', err.message);
    sendError(res, 500, 'Failed to load storage config');
  }
});

// =========================================================================
// PUT /api/admin/storage/config/:backend — Backend Credential Güncelle
// =========================================================================
// Body: { R2_BUCKET_NAME: 'foo', R2_SECRET_ACCESS_KEY: '...', ... }
// Secret alanlar için: body'de maskelenmiş değer ("••••••••") geldiği
// anlamına gelir → mevcut değeri değiştirme. Yeni değer geldiğinde üzerine yaz.
// Güncelleme sonrası provider cache invalidate edilir (bir sonraki istekte
// yeni değerlerle yeniden instantiate edilir).

addAdminRoute('PUT', '/api/admin/storage/config/:backend', async (req, res, params, body) => {
  const backend = params.backend;
  if (!storage.SUPPORTED_BACKENDS.includes(backend)) {
    return sendError(res, 400, `Desteklenmeyen backend: ${backend}`);
  }
  if (!body || Object.keys(body).length === 0) {
    return sendError(res, 400, 'Config değerleri gerekli');
  }
  try {
    const result = await storage.setBackendConfig(backend, body);
    console.log(`[Admin] Storage config updated for ${backend}: ${result.updated.join(', ') || '(no change)'} by ${req.adminUser.username}`);
    sendJSON(res, 200, {
      backend,
      updated: result.updated,
      skipped: result.skipped,
      message: result.updated.length > 0
        ? `${result.updated.length} alan güncellendi. Provider yeniden başlatıldı.`
        : 'Değişiklik yok (maskelenmiş secret atlandı veya boş değer).',
    });
  } catch (err) {
    console.error('[Admin] Storage config PUT error:', err.message);
    sendError(res, 500, 'Failed to update storage config');
  }
});

// =========================================================================
// Export
// =========================================================================

module.exports = { addAdminRoute };
