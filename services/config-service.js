/**
 * config-service.js — Sistem Yapılandırma Servisi
 * 
 * PostgreSQL `config` tablosundan okuma/yazma.
 * In-memory cache ile sık okunan değerler için performans optimizasyonu.
 * Admin panelden güncelleme yapıldığında cache invalidate edilir.
 */

const { query } = require('./database');

// =========================================================================
// In-Memory Config Cache
// =========================================================================

/**
 * Map<key, { value, cachedAt }>
 * Config değerlerini memory'de cache'ler.
 * Admin güncellemesinde invalidate edilir.
 */
const configCache = new Map();

// Cache TTL (ms) — 5 dakika sonra otomatik invalidate
const CACHE_TTL = 5 * 60 * 1000;

// =========================================================================
// Config Okuma
// =========================================================================

/**
 * Belirli bir config key'inin değerini döndürür.
 * Önce cache'e bakar, yoksa PG'den okur ve cache'ler.
 * 
 * @param {string} key - Config anahtarı (örn: 'max_file_size_mb')
 * @returns {Promise<string|null>} - Config değeri veya null
 */
async function getConfig(key) {
  // Cache kontrolü
  const cached = configCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
    return cached.value;
  }

  // PG'den oku
  try {
    const result = await query(
      `SELECT value FROM config WHERE key = $1`,
      [key]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const value = result.rows[0].value;

    // Cache'e yaz
    configCache.set(key, { value, cachedAt: Date.now() });

    return value;
  } catch (err) {
    console.error(`[Config] Error reading key "${key}":`, err.message);
    return null;
  }
}

/**
 * Tüm config değerlerini key-value objesi olarak döndürür.
 * Admin panel için.
 * 
 * @returns {Promise<Object>} - { key: value, ... }
 */
async function getAllConfig() {
  try {
    const result = await query(`SELECT key, value FROM config ORDER BY key`);

    const config = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }

    return config;
  } catch (err) {
    console.error('[Config] Error reading all config:', err.message);
    return {};
  }
}

// =========================================================================
// Config Güncelleme (Admin)
// =========================================================================

/**
 * Birden fazla config değerini günceller.
 * Her güncelleme için cache invalidate edilir.
 * 
 * @param {Object} updates - { key: newValue, ... }
 * @returns {Promise<number>} - Güncellenen key sayısı
 */
async function updateConfig(updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return 0;

  let updated = 0;

  for (const key of keys) {
    const value = String(updates[key]);

    try {
      await query(
        `INSERT INTO config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );

      // Cache'i invalidate et
      configCache.delete(key);

      updated++;
    } catch (err) {
      console.error(`[Config] Error updating key "${key}":`, err.message);
    }
  }

  return updated;
}

// =========================================================================
// Cache Yönetimi
// =========================================================================

/**
 * Tüm cache'i temizler (admin güncellemesi sonrası).
 */
function invalidateCache() {
  configCache.clear();
  console.log('[Config] Cache invalidated.');
}

/**
 * Belirli bir key'in cache'ini temizler.
 * @param {string} key
 */
function invalidateKey(key) {
  configCache.delete(key);
}

// =========================================================================
// Periyodik Cache Temizliği
// =========================================================================

// Her 10 dakikada bir süresi dolmuş cache entry'lerini temizle
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of configCache.entries()) {
    if ((now - entry.cachedAt) > CACHE_TTL) {
      configCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// =========================================================================
// Export
// =========================================================================

module.exports = {
  getConfig,
  getAllConfig,
  updateConfig,
  invalidateCache,
  invalidateKey,
};
