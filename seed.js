/**
 * seed.js — Admin kullanıcısı oluşturma script'i
 *
 * Migration'lar server.js başlangıcında zaten çalışır.
 * Bu script sadece admin kullanıcısını oluşturur.
 *
 * Kullanım:
 *   node seed.js                    → .env'deki ADMIN_USERNAME/ADMIN_PASSWORD ile
 *   node seed.js admin sifre123     → komut satırından
 */

const { createAdminUser } = require('./middleware/auth');
const { query } = require('./services/database');

async function seed() {
  // Veritabanı bağlantısını test et (migration'lar zaten server.js tarafından çalıştırıldı)
  console.log('[Seed] Checking database connection...');
  try {
    const result = await query('SELECT 1 AS ok');
    console.log('[Seed] Database connection OK.');
  } catch (err) {
    console.error('[Seed] Database connection failed:', err.message);
    console.error('[Seed] Make sure the server has started and migrations have run.');
    process.exit(1);
  }

  // Admin bilgilerini al
  const username = process.argv[2] || process.env.ADMIN_USERNAME || 'admin';
  const password = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';

  console.log(`[Seed] Creating admin user: ${username}`);
  const result = await createAdminUser(username, password);
  console.log(`[Seed] Admin user ready: ${result.username}`);
  console.log('[Seed] You can now log in at /admin');

  process.exit(0);
}

seed().catch(err => {
  console.error('[Seed] Failed:', err.message);
  process.exit(1);
});
