/**
 * storage/index.js — Object Storage Factory & Facade
 *
 * Bu modül "Bucket" mantığının merkezidir. Tüm dosya I/O artık buradan
 * geçer — upload-service, download-service, cleanup-job, preview-service
 * ve route'lar doğrudan fs/UPLOADS_DIR kullanmaz; bunun yerine bu modülün
 * sağladığı provider'ları kullanır.
 *
 * İki tip provider kullanımı vardır:
 *
 *   1. getDefaultProvider() — yeni dosyaların YAZILACAğı backend.
 *      `storage_backend` config key'i (admin panel) veya env var seçer.
 *      Startup'ta bir kez resolve edilir ve cache'lenir.
 *
 *   2. getProviderForFile(row) — mevcut bir dosyanın OKUNACAğı/SİLİNECEğı
 *      backend. Her dosya kendi `storage_backend` alanını taşır; bu sayede
 *      admin backend'i 'r2' → 'local' olarak değiştirse bile, R2'de kalmış
 *      eski dosyalar doğru backend'den silinir (orphan blob önlenir).
 *
 * Veritabanında artık `storage_path` (abs path) değil, `storage_key` (object
 * key, örn: "abc-123.mp4") ve `storage_backend` ('local'|'r2'|'supabase')
 * saklanır. Bu, sektör standartıdır: dosya → bucket, DB → sadece URL/key.
 *
 * =========================================================================
 * Credential yönetimi (DB-backed, .env fallback)
 * =========================================================================
 * Storage credential'ları (R2/Supabase access key, secret, bucket, endpoint)
 * hem `.env`'den hem de DB `config` tablosundan okunabilir. Öncelik:
 *   DB config > .env
 * Bu sayede admin panelden credential girilebilir (restart gerekmez) ve
 * `.env` ilk kurulum / fallback olarak kalır. DB'ye yazılan değerler kalıcıdır
 * (server restart'ta kaybolmaz), DB yedeği küçük olduğu için (sadece metin)
 * yedekleme maliyeti yoktur.
 *
 * NOT: Credential'lar plaintext olarak DB'de saklanır (config tablosu).
 * Bu, .env dosyasının da plaintext olmasıyla aynı güvenlik seviyesidir.
 * Üretimde DB erişimi ağ seviyesinde kısıtlanmalıdır (PostgreSQL TLS +
 * firewall). Secret'ları gerçekten şifrelemek istiyorsanız pgcrypto veya
 * vault tabanlı bir çözüm gerekir — bu proje kapsamı dışında.
 */

const { LocalStorageProvider } = require('./local-provider');
const { loadS3Sdk } = require('./s3-base');

// ---------------------------------------------------------------------------
// Provider Cache
// ---------------------------------------------------------------------------

const providerCache = new Map(); // backendName → provider instance

// ---------------------------------------------------------------------------
// Yapılandırma Çözümleme
// ---------------------------------------------------------------------------

const SUPPORTED_BACKENDS = ['local', 'r2', 'supabase'];

// Secret alanlar (DB'de AES-256-GCM ile şifreli saklanır).
// Non-secret alanlar (bucket, endpoint, region) plaintext — şifrelemeye değmez.
const SECRET_FIELDS = {
  r2: ['R2_SECRET_ACCESS_KEY'],
  supabase: ['SUPABASE_S3_SECRET_ACCESS_KEY'],
};

/**
 * Config/env'den hangi backend'in aktif olduğunu döndürür.
 * Öncelik: env STORAGE_BACKEND > 'local'.
 * (DB config'ten okuma server.js startup'ta setActiveBackend ile set edilir.)
 *
 * @returns {string} 'local' | 'r2' | 'supabase'
 */
function resolveBackendFromEnv() {
  const raw = (process.env.STORAGE_BACKEND || '').toLowerCase().trim();
  if (SUPPORTED_BACKENDS.includes(raw)) return raw;
  return 'local';
}

// Aktif (yeni yazma) backend — setDefaultBackend ile set edilir, yoksa env.
let activeBackend = null;

/**
 * Aktif backend'i set eder (server.js startup'ta config'ten okuyup çağırır).
 * @param {string} backend
 */
function setActiveBackend(backend) {
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(`Desteklenmeyen storage backend: ${backend}. Desteklenenler: ${SUPPORTED_BACKENDS.join(', ')}`);
  }
  activeBackend = backend;
}

/**
 * Aktif backend adını döndürür.
 */
function getActiveBackendName() {
  return activeBackend || resolveBackendFromEnv();
}

// ---------------------------------------------------------------------------
// DB-backed Credential Okuma
// ---------------------------------------------------------------------------

/**
 * Bir backend için config değerlerini çözer. Öncelik:
 *   DB config tablosu (storage:prefix:key) > process.env > null
 *
 * Not: config-service require edildiğinde circular dependency oluşabilir
 * (config-service → database → ...), bu yüzden lazy require kullanıyoruz.
 *
 * Secret alanlar DB'de AES-256-GCM ile şifreli saklanır (crypto-vault.js).
 * Okurken decrypt edilir. .env'den gelen değerler plaintext'tir (fallback).
 *
 * @param {string} backend - 'local' | 'r2' | 'supabase'
 * @param {Array<string>} keys - [envVarName, ...] — hem env hem DB'de aranır
 * @returns {Promise<Object>} - { [envVarName]: plaintextValue }
 * @private
 */
async function resolveConfigKeys(backend, keys) {
  const { decrypt } = require('../crypto-vault');
  const secretSet = new Set(SECRET_FIELDS[backend] || []);

  const result = {};
  // .env fallback — önce tüm key'leri env'den doldur (plaintext)
  for (const envKey of keys) {
    if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
      result[envKey] = process.env[envKey];
    }
  }
  // DB config override — config tablosundan storage:<backend>:<key> oku
  // Secret alanlar şifreli → decrypt gerekir.
  try {
    const { query } = require('../database');
    const dbKeys = keys.map(k => `storage:${backend}:${k}`);
    const placeholders = dbKeys.map((_, i) => `$${i + 1}`).join(',');
    const res = await query(
      `SELECT key, value FROM config WHERE key IN (${placeholders})`,
      dbKeys
    );
    for (const row of res.rows) {
      // storage:r2:R2_BUCKET_NAME → R2_BUCKET_NAME
      const envKey = row.key.replace(`storage:${backend}:`, '');
      if (row.value !== null && row.value !== undefined && row.value !== '') {
        if (secretSet.has(envKey)) {
          // Secret → decrypt et (RAM'de plaintext)
          try {
            result[envKey] = decrypt(row.value);
          } catch (decErr) {
            console.error(`[Storage] Decrypt failed for ${backend}:${envKey}:`, decErr.message);
            // Decrypt hatası: değeri at, .env fallback veya boş kullan
          }
        } else {
          // Non-secret → plaintext
          result[envKey] = row.value;
        }
      }
    }
  } catch (err) {
    // DB henüz hazır değilse veya tablo yoksa env ile devam et
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[Storage] DB config read skipped for ${backend}:`, err.message);
    }
  }
  return result;
}

/**
 * Local provider config'ini çözer.
 * @returns {Promise<Object>}
 */
async function resolveLocalConfig() {
  const keys = ['UPLOADS_DIR', 'CHUNK_TMP_DIR', 'THUMBS_DIR'];
  const cfg = await resolveConfigKeys('local', keys);
  return {
    uploadsDir: cfg.UPLOADS_DIR || process.env.UPLOADS_DIR || '/data/uploads',
  };
}

/**
 * R2 provider config'ini çözer (DB > env) ve provider constructor'ının
 * beklediği camelCase alan adlarına map'ler.
 *
 * ÖNEMLİ: resolveConfigKeys SCREAMING_SNAKE env key'leriyle ({ R2_ACCOUNT_ID, ... })
 * döner — bunlar DB'de `storage:r2:R2_*` ve .env `R2_*` olarak saklanır (arayüz
 * kontratı budur, değiştirilmemeli). Ama R2StorageProvider constructor'ı camelCase
 * bekler (config.accountId, config.bucket, ...). Bu map'leme olmadan DB'den okunan
 * değerler constructor'a undefined olarak gider, provider env fallback'ine düşer ve
 * admin panelden girilen credential'lar etkisiz kalırdı (switch anında
 * "R2_ACCOUNT_ID zorunludur" hatası). resolveLocalConfig'in yaptığı gibi map'liyoruz.
 *
 * @returns {Promise<Object>} - { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl, presignExpiresIn }
 */
async function resolveR2Config() {
  const cfg = await resolveConfigKeys('r2', [
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME', 'R2_PUBLIC_BASE_URL', 'R2_PRESIGN_EXPIRES_IN',
  ]);
  const presignRaw = cfg.R2_PRESIGN_EXPIRES_IN;
  return {
    accountId: cfg.R2_ACCOUNT_ID || undefined,
    accessKeyId: cfg.R2_ACCESS_KEY_ID || undefined,
    secretAccessKey: cfg.R2_SECRET_ACCESS_KEY || undefined,
    bucket: cfg.R2_BUCKET_NAME || undefined,
    publicBaseUrl: cfg.R2_PUBLIC_BASE_URL || undefined,
    presignExpiresIn: presignRaw ? parseInt(presignRaw, 10) : undefined,
  };
}

/**
 * Supabase provider config'ini çözer (DB > env) ve provider constructor'ının
 * beklediği camelCase alan adlarına map'ler. (resolveR2Config ile aynı sebep —
 * bkz. yukarıdaki açıklama.)
 *
 * @returns {Promise<Object>} - { endpoint, region, accessKeyId, secretAccessKey, bucket, publicBaseUrl, presignExpiresIn }
 */
async function resolveSupabaseConfig() {
  const cfg = await resolveConfigKeys('supabase', [
    'SUPABASE_S3_ENDPOINT', 'SUPABASE_S3_REGION',
    'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY',
    'SUPABASE_S3_BUCKET', 'SUPABASE_S3_PUBLIC_BASE_URL', 'SUPABASE_PRESIGN_EXPIRES_IN',
  ]);
  const presignRaw = cfg.SUPABASE_PRESIGN_EXPIRES_IN;
  return {
    endpoint: cfg.SUPABASE_S3_ENDPOINT || undefined,
    region: cfg.SUPABASE_S3_REGION || undefined,
    accessKeyId: cfg.SUPABASE_S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: cfg.SUPABASE_S3_SECRET_ACCESS_KEY || undefined,
    bucket: cfg.SUPABASE_S3_BUCKET || undefined,
    publicBaseUrl: cfg.SUPABASE_S3_PUBLIC_BASE_URL || undefined,
    presignExpiresIn: presignRaw ? parseInt(presignRaw, 10) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider Oluşturma
// ---------------------------------------------------------------------------

/**
 * Verilen backend için provider instance döndürür (cache'li).
 * Credential'lar DB config > env sırasıyla çözülür.
 * Bağımlılık/credential eksikse hata fırlatır.
 *
 * @param {string} backend - 'local' | 'r2' | 'supabase'
 * @returns {Promise<Object>}
 */
async function getProvider(backend) {
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(`Desteklenmeyen storage backend: ${backend}`);
  }

  if (providerCache.has(backend)) {
    return providerCache.get(backend);
  }

  let provider;
  if (backend === 'local') {
    const cfg = await resolveLocalConfig();
    provider = new LocalStorageProvider(cfg);
  } else if (backend === 'r2') {
    const { R2StorageProvider } = require('./r2-provider');
    const cfg = await resolveR2Config();
    provider = new R2StorageProvider(cfg);
  } else if (backend === 'supabase') {
    const { SupabaseStorageProvider } = require('./supabase-provider');
    const cfg = await resolveSupabaseConfig();
    provider = new SupabaseStorageProvider(cfg);
  }

  await provider.ensureReady();
  providerCache.set(backend, provider);
  return provider;
}

/**
 * Yeni dosyaların yazılacağı (aktif) provider.
 * @returns {Promise<Object>}
 */
async function getDefaultProvider() {
  return getProvider(getActiveBackendName());
}

/**
 * Bir dosya kaydının (DB row) backend'ine göre provider döndürür.
 * storage_backend null/boşsa (eski kayıt veya migration backfill) → local.
 *
 * @param {{ storage_backend?: string|null }} fileRow
 * @returns {Promise<Object>}
 */
async function getProviderForFile(fileRow) {
  const backend = (fileRow && fileRow.storage_backend) || 'local';
  return getProvider(backend);
}

// ---------------------------------------------------------------------------
// Cache Invalidation (credential değişince provider yeniden instantiate)
// ---------------------------------------------------------------------------

/**
 * Belirli bir backend'in cache'lenmiş provider'ını geçersiz kılar.
 * Bir sonraki getProvider() çağrısında credential'lar yeniden DB'den okunur.
 * Admin credential güncellediğinde çağrılır.
 *
 * @param {string} backend - 'local' | 'r2' | 'supabase' (yoksa hepsi)
 */
function invalidateProvider(backend) {
  if (backend) {
    providerCache.delete(backend);
  } else {
    providerCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Backend Durum Kontrolü
// ---------------------------------------------------------------------------

/**
 * Bir backend'in kullanılabilir durumda olup olmadığını kontrol eder
 * (credential/bağımlılık var mı). Admin panel UI için kullanılır.
 * Credential'ları DB > env sırasıyla çözer.
 *
 * @param {string} backend
 * @returns {Promise<{ available: boolean, error?: string, missingDeps?: string[] }>}
 */
async function checkBackendAvailability(backend) {
  if (backend === 'local') {
    return { available: true };
  }

  // S3-uyumlu provider'lar için SDK kontrolü
  if (!loadS3Sdk()) {
    return {
      available: false,
      error: 'AWS SDK v3 paketleri yüklü değil.',
      missingDeps: ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', '@aws-sdk/s3-request-presigner'],
    };
  }

  try {
    if (backend === 'r2') {
      // resolveR2Config artık camelCase döndürür (provider constructor ile uyumlu).
      // Eksik alan adları arayüzde gösterilen env key'leriyle eşleşsin diye mesajda
      // SCREAMING formu kullanıyoruz (admin schema da böyle gösterir).
      const cfg = await resolveR2Config();
      if (!cfg.accountId) return { available: false, error: 'R2_ACCOUNT_ID eksik.' };
      if (!cfg.accessKeyId) return { available: false, error: 'R2_ACCESS_KEY_ID eksik.' };
      if (!cfg.secretAccessKey) return { available: false, error: 'R2_SECRET_ACCESS_KEY eksik.' };
      if (!cfg.bucket) return { available: false, error: 'R2_BUCKET_NAME eksik.' };
      return { available: true };
    }
    if (backend === 'supabase') {
      const cfg = await resolveSupabaseConfig();
      if (!cfg.endpoint) return { available: false, error: 'SUPABASE_S3_ENDPOINT eksik.' };
      if (!cfg.accessKeyId) return { available: false, error: 'SUPABASE_S3_ACCESS_KEY_ID eksik.' };
      if (!cfg.secretAccessKey) return { available: false, error: 'SUPABASE_S3_SECRET_ACCESS_KEY eksik.' };
      if (!cfg.bucket) return { available: false, error: 'SUPABASE_S3_BUCKET eksik.' };
      return { available: true };
    }
  } catch (err) {
    return { available: false, error: err.message };
  }

  return { available: false, error: 'Bilinmeyen backend.' };
}

/**
 * Tüm backend'lerin durum raporunu döndürür (admin dashboard için).
 * @returns {Promise<Array<{ backend: string, active: boolean, available: boolean, error?: string, missingDeps?: string[] }>>}
 */
async function getBackendStatuses() {
  const active = getActiveBackendName();
  const results = [];
  for (const backend of SUPPORTED_BACKENDS) {
    const check = await checkBackendAvailability(backend);
    results.push({
      backend,
      active: backend === active,
      ...check,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Credential Yapılandırması (GET / SET — admin panel için)
// ---------------------------------------------------------------------------

// Backend başına config şeması — UI'da hangi alanların gösterileceğini belirler.
// (SECRET_FIELDS yukarıda, SUPPORTED_BACKENDS altında tanımlı — resolveConfigKeys
//  onu kullanır, bu yüzden önde tanımlandı.)
const BACKEND_CONFIG_SCHEMA = {
  local: [],
  r2: [
    { key: 'R2_ACCOUNT_ID', label: 'Account ID', secret: false, placeholder: 'Cloudflare account ID' },
    { key: 'R2_ACCESS_KEY_ID', label: 'Access Key ID', secret: false, placeholder: 'R2 API access key' },
    { key: 'R2_SECRET_ACCESS_KEY', label: 'Secret Access Key', secret: true, placeholder: 'R2 API secret' },
    { key: 'R2_BUCKET_NAME', label: 'Bucket Name', secret: false, placeholder: 'my-filesfly-bucket' },
    { key: 'R2_PUBLIC_BASE_URL', label: 'Public Base URL (opsiyonel)', secret: false, placeholder: 'https://<id>.r2.dev' },
    { key: 'R2_PRESIGN_EXPIRES_IN', label: 'Presigned URL Süresi (sn)', secret: false, placeholder: '3600' },
  ],
  supabase: [
    { key: 'SUPABASE_S3_ENDPOINT', label: 'S3 Endpoint', secret: false, placeholder: 'https://<project>.supabase.co/storage/v1/s3' },
    { key: 'SUPABASE_S3_REGION', label: 'Region', secret: false, placeholder: 'us-east-1' },
    { key: 'SUPABASE_S3_ACCESS_KEY_ID', label: 'Access Key ID', secret: false, placeholder: 'S3 access key' },
    { key: 'SUPABASE_S3_SECRET_ACCESS_KEY', label: 'Secret Access Key', secret: true, placeholder: 'S3 secret' },
    { key: 'SUPABASE_S3_BUCKET', label: 'Bucket Name', secret: false, placeholder: 'filesfly' },
    { key: 'SUPABASE_S3_PUBLIC_BASE_URL', label: 'Public Base URL (opsiyonel)', secret: false, placeholder: 'https://<project>.supabase.co/storage/v1/object/public/' },
    { key: 'SUPABASE_PRESIGN_EXPIRES_IN', label: 'Presigned URL Süresi (sn)', secret: false, placeholder: '3600' },
  ],
};

/**
 * Bir backend'in config değerlerini döndürür (admin panel GET).
 *
 * Secret alanlar için: ASLA raw değeri frontend'e gönderme. Bunun yerine
 * "Ayarlandı" (set) veya null (unset) döner. Frontend "Ayarlandı" gördüğünde
 * input'u boş bırakır + "Ayarlandı" rozeti gösterir; yeni değer girilirse
 * üzerine yazılır.
 *
 * Non-secret alanlar (bucket, endpoint, region) plaintext döner.
 * Boş alanlar null döner (UI'da placeholder gösterilir).
 *
 * @param {string} backend
 * @returns {Promise<{ backend: string, config: Object, schema: Array }>}
 */
async function getBackendConfig(backend) {
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(`Desteklenmeyen backend: ${backend}`);
  }
  const schema = BACKEND_CONFIG_SCHEMA[backend] || [];
  const envKeys = schema.map(s => s.key);
  const rawCfg = await resolveConfigKeys(backend, envKeys);

  const safe = {};
  for (const field of schema) {
    const val = rawCfg[field.key];
    if (val === undefined || val === null || val === '') {
      safe[field.key] = null;
    } else if (field.secret && val) {
      // Secret → "Ayarlandı" (asla raw değeri frontend'e gönderme)
      safe[field.key] = 'Ayarlandı';
    } else {
      safe[field.key] = val;
    }
  }

  return { backend, config: safe, schema };
}

/**
 * Bir backend'in config değerlerini günceller (admin panel PUT).
 *
 * Secret alanlar: AES-256-GCM ile şifrelenip DB'ye yazılır (crypto-vault.js).
 * - Yeni değer geldi → encrypt + DB'ye yaz
 * - "Ayarlandı" (masked placeholder) geldi → mevcut değeri koru (skip)
 * - Boş değer geldi → mevcut değeri temizle (DB'den sil)
 *
 * Non-secret alanlar: plaintext olarak DB'ye yazılır.
 *
 * @param {string} backend
 * @param {Object} updates - { R2_BUCKET_NAME: 'foo', R2_SECRET_ACCESS_KEY: '...' }
 * @param {Object} [auditCtx] - { adminUser } — audit log için (opsiyonel)
 * @returns {Promise<{ updated: string[], skipped: string[] }>}
 */
async function setBackendConfig(backend, updates, auditCtx) {
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(`Desteklenmeyen backend: ${backend}`);
  }
  const { encrypt } = require('../crypto-vault');
  const schema = BACKEND_CONFIG_SCHEMA[backend] || [];
  const schemaKeys = new Set(schema.map(s => s.key));

  const { updateConfig, invalidateKey } = require('../config-service');
  const updated = [];
  const skipped = [];

  // Önce mevcut değerleri çek (skip kararı için)
  const currentRaw = await resolveConfigKeys(backend, [...schemaKeys]);

  for (const [key, value] of Object.entries(updates)) {
    if (!schemaKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    const field = schema.find(s => s.key === key);
    const trimmed = (value === null || value === undefined) ? '' : String(value).trim();

    // Secret alan + "Ayarlandı" placeholder geldi → mevcut değeri koru (skip)
    if (field.secret && trimmed === 'Ayarlandı') {
      skipped.push(key);
      continue;
    }
    // Boş değer geldi ve mevcut değer de boş → atla
    if (!trimmed && !currentRaw[key]) {
      skipped.push(key);
      continue;
    }

    // DB'ye yazılacak değer: secret ise encrypt et, değilse plaintext
    let dbValue = trimmed;
    if (field.secret && trimmed) {
      dbValue = encrypt(trimmed);
    }

    // DB'ye yaz: storage:<backend>:<key>
    const dbKey = `storage:${backend}:${key}`;
    await updateConfig({ [dbKey]: dbValue });
    invalidateKey(dbKey);
    updated.push(key);
  }

  // Provider cache'ini invalidate et — bir sonraki getProvider yeni değerleri okur
  if (updated.length > 0) {
    invalidateProvider(backend);
  }

  // Audit log (opsiyonel — admin route'tan auditCtx verilirse)
  if (auditCtx && auditCtx.adminUser && updated.length > 0) {
    try {
      const { logAudit } = require('../audit-service');
      await logAudit({
        adminUser: auditCtx.adminUser,
        action: 'storage_credential_update',
        target: backend,
        metadata: { updated, skipped },
      });
    } catch (err) {
      console.error('[Storage] Audit log failed:', err.message);
      // Audit hatası credential güncellemesini engellemesin
    }
  }

  return { updated, skipped };
}

// ---------------------------------------------------------------------------
// Plaintext Secret Migration (migration 003 — startup'ta çalışır)
// ---------------------------------------------------------------------------

/**
 * DB'de plaintext olarak kalmış storage secret'lerini AES-256-GCM ile şifreler.
 * Migration 003 'storage:secrets_migration_pending' flag'i set eder; bu fonksiyon
 * startup'ta o flag'i görür, plaintext secret'leri şifreler, flag'i temizler.
 *
 * Strateji:
 *   - Her backend için SECRET_FIELDS'deki key'leri tara
 *   - "enc:v1:" prefix'i OLMAYAN değerler plaintext → encrypt + UPDATE
 *   - "enc:v1:" prefix'i olan değerler zaten şifreli → atla
 *   - Boş değerler → atla
 *   - Sonuç: tüm secret'ler şifreli, flag temizlenir
 *
 * Master Key yoksa (dev): migration atlanır (plaintext kalır, warning verilir).
 * Flag korunur — Master Key set edilip restart edilince migration çalışır.
 *
 * @returns {Promise<{ migrated: number, skipped: number, deferred: boolean }>}
 */
async function migratePlaintextSecrets() {
  const { isEncrypted, encrypt, isEncryptionEnabled } = require('../crypto-vault');

  // Master Key yoksa → ertele (flag korunur)
  if (!isEncryptionEnabled()) {
    console.warn('[Storage] Plaintext secret migration ertelendi — CREDENTIALS_MASTER_KEY yok.');
    return { migrated: 0, skipped: 0, deferred: true };
  }

  let migrated = 0;
  let skipped = 0;

  try {
    const { query } = require('../database');

    // Flag var mı?
    const flagRes = await query(
      `SELECT value FROM config WHERE key = 'storage:secrets_migration_pending'`
    );
    if (flagRes.rows.length === 0 || flagRes.rows[0].value !== '1') {
      // Flag yok → migration zaten yapılmış, atla
      return { migrated: 0, skipped: 0, deferred: false };
    }

    console.log('[Storage] Plaintext secret migration başlıyor...');

    // Her backend'in secret key'lerini tara
    for (const backend of Object.keys(SECRET_FIELDS)) {
      const secretKeys = SECRET_FIELDS[backend];
      const dbKeys = secretKeys.map(k => `storage:${backend}:${k}`);
      const placeholders = dbKeys.map((_, i) => `$${i + 1}`).join(',');

      const res = await query(
        `SELECT key, value FROM config WHERE key IN (${placeholders})`,
        dbKeys
      );

      for (const row of res.rows) {
        const value = row.value;
        if (value === null || value === undefined || value === '') {
          skipped++;
          continue;
        }
        if (isEncrypted(value)) {
          // Zaten şifreli
          skipped++;
          continue;
        }
        // Plaintext → encrypt + UPDATE
        const encrypted = encrypt(value);
        await query(
          `UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2`,
          [encrypted, row.key]
        );
        migrated++;
        console.log(`[Storage] Encrypted ${row.key} (was plaintext).`);
      }
    }

    // Flag'i temizle
    await query(`DELETE FROM config WHERE key = 'storage:secrets_migration_pending'`);

    console.log(`[Storage] Plaintext secret migration tamam: ${migrated} encrypted, ${skipped} skipped.`);
    return { migrated, skipped, deferred: false };
  } catch (err) {
    console.error('[Storage] Plaintext secret migration hatası:', err.message);
    // Flag korunur — bir sonraki restart'ta tekrar dener
    return { migrated, skipped, deferred: true };
  }
}

// ---------------------------------------------------------------------------
// Thumbnail Storage (her zaman local — küçük, sık erişilen, geçici cache)
// ---------------------------------------------------------------------------
// Thumbnail'lar ana dosya backend'inden BAĞIMSIZ olarak her zaman local diskte
// saklanır. Neden:
//   1. Küçük (<50KB) ve geçici (dosya silinince silinir) → cloud'a yüklemeye değmez
//   2. Admin paneli streaming olarak yükler → gecikme istenmez
//   3. Eski thumbnail mantığını korur — sharp generate/read aynı disk path'i
//
// Bu yüzden thumbnail I/O storage-service.js (eski modül) üzerinden local
// fs olarak kalır. Ana dosya I/O bu modülden geçer.

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  // Provider erişimi
  getProvider,
  getDefaultProvider,
  getProviderForFile,
  // Backend seçimi
  getActiveBackendName,
  setActiveBackend,
  resolveBackendFromEnv,
  SUPPORTED_BACKENDS,
  // Durum
  checkBackendAvailability,
  getBackendStatuses,
  // Cache invalidation
  invalidateProvider,
  // Credential yönetimi (admin panel)
  getBackendConfig,
  setBackendConfig,
  BACKEND_CONFIG_SCHEMA,
  SECRET_FIELDS,
  // Migration (startup)
  migratePlaintextSecrets,
};
