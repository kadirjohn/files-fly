/**
 * crypto-vault.js — Credential Encryption at Rest (AES-256-GCM)
 *
 * Admin panelden girilen storage credential'ları (R2/Supabase secret key)
 * veritabanına düz metin (plaintext) olarak DEĞİL, AES-256-GCM ile
 * şifrelenerek yazılır. Böylece DB sızdırılsa bile içindeki anahtarlar
 * okunamaz — tek başına `.env`'deki Master Key çürütmek yeterli.
 *
 * Mimari:
 *   .env (CREDENTIALS_MASTER_KEY) → PBKDF2 → 32-byte AES-256 key
 *   plaintext → AES-256-GCM encrypt → "enc:v1:<iv>:<tag>:<ciphertext>" (base64)
 *   DB'de bu string saklanır. Okurken tersi: decrypt → RAM'de plaintext.
 *
 * Format (enc:v1): prefix ile encrypted/plaintext ayrımı yapılır.
 *   - "enc:v1:..." → şifreli (decrypt gerekir)
 *   - diğer tüm değerler → plaintext (.env fallback veya eski veri)
 *   Bu sayede migration olmadan karışık durumda çalışır.
 *
 * Master Key yoksa (development): plaintext fallback (warning ile).
 * Üretimde CREDENTIALS_MASTER_KEY set edilmelidir.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Master Key yönetimi
// ---------------------------------------------------------------------------

const ENCRYPT_PREFIX = 'enc:v1:';
const PBKDF2_ITERATIONS = 100000; // OWASP 2023 önerisi
const PBKDF2_KEYLEN = 32;        // 256 bit (AES-256)
const PBKDF2_SALT = 'filesfly-storage-credential-salt'; // Sabit salt (key derivation)

let derivedKeyCache = null;
let masterKeyWarningShown = false;

/**
 * .env'den Master Key'i okur, AES-256 key türetir (PBKDF2).
 * Master Key yoksa null döner → plaintext fallback.
 * @returns {Buffer|null} 32-byte AES key, veya null (plaintext mode)
 * @private
 */
function getDerivedKey() {
  if (derivedKeyCache !== null) return derivedKeyCache;

  const masterKey = process.env.CREDENTIALS_MASTER_KEY;
  if (!masterKey) {
    if (!masterKeyWarningShown) {
      console.warn('[Vault] CREDENTIALS_MASTER_KEY .env\'de yok — credential\'lar plaintext saklanacak (geliştirme modu). Üretimde set edin!');
      masterKeyWarningShown = true;
    }
    derivedKeyCache = false; // sentinel: "no key, plaintext mode"
    return null;
  }

  // PBKDF2 ile 32-byte AES key türet
  derivedKeyCache = crypto.pbkdf2Sync(masterKey, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
  return derivedKeyCache;
}

/**
 * Şifreleme aktif mi? (Master Key set edilmiş mi?)
 * @returns {boolean}
 */
function isEncryptionEnabled() {
  return getDerivedKey() !== null;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Plaintext değeri AES-256-GCM ile şifreler.
 * Master Key yoksa plaintext döner (fallback).
 *
 * @param {string} plaintext
 * @returns {string} - "enc:v1:<iv>:<tag>:<ciphertext>" veya plaintext (fallback)
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;

  const key = getDerivedKey();
  if (!key) return String(plaintext); // plaintext fallback (no master key)

  const iv = crypto.randomBytes(12); // 96-bit IV (GCM standard)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 byte auth tag

  // Format: enc:v1:<iv-base64>:<tag-base64>:<ct-base64>
  return ENCRYPT_PREFIX +
    iv.toString('base64') + ':' +
    tag.toString('base64') + ':' +
    ct.toString('base64');
}

/**
 * Şifreli değeri çözer (AES-256-GCM).
 * "enc:v1:" prefix'i yoksa plaintext döner (.env fallback veya eski veri).
 * Auth tag mismatch → decrypt hatası (veri bozulmuş veya Master Key değişmiş).
 *
 * @param {string} blob - "enc:v1:..." veya plaintext
 * @returns {string|null} - Plaintext veya null (boş değer)
 * @throws {Error} - Auth tag mismatch (Master Key değişmiş) veya decrypt hatası
 */
function decrypt(blob) {
  if (blob === null || blob === undefined || blob === '') return null;
  const str = String(blob);

  // "enc:v1:" yoksa plaintext (.env fallback veya encryption-disabled)
  if (!str.startsWith(ENCRYPT_PREFIX)) return str;

  const key = getDerivedKey();
  if (!key) {
    // Encryption disabled ama veri şifreli → decrypt edilemez
    throw new Error('Veri şifreli (enc:v1) ama CREDENTIALS_MASTER_KEY .env\'de yok — decrypt edilemedi.');
  }

  // Format: enc:v1:<iv>:<tag>:<ct>
  const parts = str.substring(ENCRYPT_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Geçersiz encrypted format (parça sayısı).');
  }
  const [ivB64, tagB64, ctB64] = parts;

  let iv, tag, ct;
  try {
    iv = Buffer.from(ivB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
    ct = Buffer.from(ctB64, 'base64');
  } catch {
    throw new Error('Geçersiz encrypted format (base64 decode).');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([
      decipher.update(ct),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch (err) {
    throw new Error(`Decrypt hatası (Master Key değişmiş olabilir): ${err.message}`);
  }
}

/**
 * Değer şifreli mi? (enc:v1 prefix'i var mı?)
 * @param {string} blob
 * @returns {boolean}
 */
function isEncrypted(blob) {
  if (blob === null || blob === undefined || blob === '') return false;
  return String(blob).startsWith(ENCRYPT_PREFIX);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  isEncryptionEnabled,
  ENCRYPT_PREFIX,
};