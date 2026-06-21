/**
 * database.js — PostgreSQL connection pool + migration runner
 * 
 * Tek npm bağımlılığı olan `pg` paketini kullanır.
 * Pool oluşturur, migration'ları çalıştırır, bağlantıyı yönetir.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Bağlantı URL'si — environment variable'dan veya varsayılan
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://filesfly:filesfly_secret@localhost:5432/filesfly';

// ---------------------------------------------------------------------------
// Connection Pool
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,              // Maksimum eşzamanlı bağlantı
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Pool hata yönetimi
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ---------------------------------------------------------------------------
// Migration Runner
// ---------------------------------------------------------------------------

/**
 * migrations/ dizinindeki tüm .sql dosyalarını sırayla çalıştırır.
 * Her migration bir transaction içinde çalışır.
 * @returns {Promise<number>} Çalıştırılan migration sayısı
 */
async function runMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  
  // migrations dizini var mı?
  if (!fs.existsSync(migrationsDir)) {
    console.log('[DB] No migrations directory found, skipping.');
    return 0;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // 001-..., 002-... sıralı

  if (files.length === 0) {
    console.log('[DB] No migration files found.');
    return 0;
  }

  const client = await pool.connect();
  let count = 0;

  try {
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`[DB] Running migration: ${file}`);
      
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`[DB] ✓ Migration ${file} completed.`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[DB] ✗ Migration ${file} failed:`, err.message);
        throw err; // Migration hatasında dur
      }
    }
  } finally {
    client.release();
  }

  console.log(`[DB] ${count} migration(s) run successfully.`);
  return count;
}

// ---------------------------------------------------------------------------
// Yardımcı: Tek sorgu çalıştırma
// ---------------------------------------------------------------------------

/**
 * Parametreli sorgu çalıştırır (SQL injection korumalı).
 * @param {string} text - SQL sorgusu ($1, $2... parametreli)
 * @param {Array} params - Parametre değerleri
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Pool'dan bir client alır (transaction'lar için).
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

// ---------------------------------------------------------------------------
// Başlatma
// ---------------------------------------------------------------------------

/**
 * Veritabanı bağlantısını başlatır ve migration'ları çalıştırır.
 * --migrate argümanı ile doğrudan çağrılabilir: node services/database.js --migrate
 */
async function initDatabase() {
  // Bağlantıyı test et
  try {
    const client = await pool.connect();
    console.log('[DB] PostgreSQL connection established.');
    client.release();
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err.message);
    console.error('[DB] Connection URL:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
    throw err;
  }

  // Migration'ları çalıştır
  await runMigrations();
}

// ---------------------------------------------------------------------------
// CLI: node services/database.js --migrate
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--migrate')) {
    initDatabase()
      .then(() => {
        console.log('[DB] Migration complete. Exiting.');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[DB] Migration failed:', err.message);
        process.exit(1);
      });
  } else {
    console.log('Usage: node services/database.js --migrate');
    process.exit(0);
  }
}

module.exports = { pool, query, getClient, initDatabase, runMigrations };
