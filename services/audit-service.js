/**
 * audit-service.js — Admin Denetim Günlüğü (Audit Log)
 *
 * Hassas işlemleri (credential değişikliği, storage backend switch, ban/unban,
 * config güncelleme, dosya silme) who/when/what biçiminde DB'ye kaydeder.
 * Admin panelde "Son Değişiklikler" bölümünde gösterilir.
 *
 * NOT: metadata alanı JSONB — esnek, structured veri (hangi key'ler güncellendi vb.).
 * Hassas DEĞERLER asla metadata'ya yazılmaz (sadece key adları, status vb.).
 */

const { query } = require('./database');

// ---------------------------------------------------------------------------
// Audit Log Yazma
// ---------------------------------------------------------------------------

/**
 * Bir audit log kaydı ekler.
 *
 * @param {Object} entry
 * @param {string} entry.adminUser - İşlemi yapan admin kullanıcı adı
 * @param {string} entry.action - İşlem tipi (örn: 'storage_credential_update')
 * @param {string} entry.target - İşlem hedefi (örn: 'r2', 'filesfly-db', fileId)
 * @param {Object} [entry.metadata] - Ek structured veri (JSONB)
 * @returns {Promise<Object>} - Eklenen kayıt
 */
async function logAudit({ adminUser, action, target, metadata = null }) {
  if (!adminUser || !action) {
    throw new Error('logAudit: adminUser ve action zorunludur');
  }

  const result = await query(
    `INSERT INTO audit_log (admin_user, action, target, metadata, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, admin_user, action, target, metadata, created_at`,
    [adminUser, action, target || null, JSON.stringify(metadata || {})]
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Audit Log Okuma
// ---------------------------------------------------------------------------

/**
 * Audit log kayıtlarını sayfalı döndürür (admin panel).
 *
 * @param {Object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.action] - Filtre: sadece bu action
 * @param {string} [opts.adminUser] - Filtre: sadece bu admin
 * @returns {Promise<{ logs: Array, total: number, page: number, pages: number }>}
 */
async function getAuditLog(opts = {}) {
  const page = Math.max(1, parseInt(opts.page) || 1);
  const limit = Math.min(parseInt(opts.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = [];
  const values = [];
  let paramIndex = 1;

  if (opts.action) {
    conditions.push(`action = $${paramIndex}`);
    values.push(opts.action);
    paramIndex++;
  }
  if (opts.adminUser) {
    conditions.push(`admin_user = $${paramIndex}`);
    values.push(opts.adminUser);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Toplam sayı
  const countResult = await query(
    `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].total);

  // Kayıtlar
  const logsResult = await query(
    `SELECT id, admin_user, action, target, metadata, created_at
     FROM audit_log ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...values, limit, offset]
  );

  return {
    logs: logsResult.rows,
    total,
    page,
    pages: Math.ceil(total / limit),
  };
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  logAudit,
  getAuditLog,
};
