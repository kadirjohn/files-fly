/**
 * seed.js — Admin kullanıcısı oluşturma script'i
 *
 * Kullanım:
 *   node seed.js                    → .env'deki ADMIN_USERNAME/ADMIN_PASSWORD ile
 *   node seed.js admin sifre123     → komut satırından
 */

const { createAdminUser } = require('./middleware/auth');
const { initDatabase } = require('./services/database');

async function seed() {
  // Veritabanına bağlan
  console.log('[Seed] Connecting to database...');
  await initDatabase();

  // Admin bilgilerini al
  const username = process.argv[2] || process.env.ADMIN_USERNAME || 'admin';
  const password = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';

  console.log(`[Seed] Creating admin user: ${username}`);
  const result = await createAdminUser(username, password);
  console.log(`[Seed] Admin user created: ${result.username}`);

  process.exit(0);
}

seed().catch(err => {
  console.error('[Seed] Failed:', err.message);
  process.exit(1);
});
