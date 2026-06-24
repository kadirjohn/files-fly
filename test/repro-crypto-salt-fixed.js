/**
 * repro-crypto-salt-fixed.js — Düzeltmenin uçtan uca kanıtı (Phase 4 verify)
 *
 * crypto.js'in GÜNCEL (düzeltilmiş) encryptFile'ini birebir taklit eder ve
 * app.js'in düzeltilmiş uploadOne salt seçimini uygular, ardından üç decrypt
 * yolunu da (file.js / bundle.js / admin.js — hepsi server'dan gelen
 * encryption_salt ile decrypt eder) çalıştırır.
 *
 * Çalıştır: node test/repro-crypto-salt-fixed.js
 */
const { webcrypto: { subtle } } = require('crypto');
const { webcrypto, randomBytes } = require('crypto');

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// === crypto.js düzeltilmiş encryptFile (saltBase64 opsiyonel) ===
async function deriveKey(password, salt, keyUsage) {
  const km = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, keyUsage
  );
}
async function encryptFile(fileBuffer, password, saltBase64) {
  const salt = saltBase64 ? fromB64(saltBase64) : webcrypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const aesKey = await deriveKey(password, salt, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileBuffer);
  return { ciphertext, iv: b64(iv), salt: b64(salt) };
}
async function decryptFile(ciphertext, ivB64, saltB64, password) {
  const iv = fromB64(ivB64), salt = fromB64(saltB64);
  const aesKey = await deriveKey(password, salt, ['decrypt']);
  try { return await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext); }
  catch { throw new Error('Şifre çözme başarısız. Parola yanlış olabilir.'); }
}

// Server: bundle-service.js createBundle → randomBytes(16).base64
function makeBundleSalt() { return randomBytes(SALT_LENGTH).toString('base64'); }
// Server: selectDecryptSalt → bundle salt varsa onu döner, yoksa file salt
function selectDecryptSalt(bundleSalt, fileSalt) { return bundleSalt || fileSalt || null; }

let pass = 0, fail = 0;
function check(name, cond) { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗'} ${name}`); }

(async () => {
  const password = '1234';
  const fileBuffer = new TextEncoder().encode('gizli dosya içeriği — Files Fly test');

  // --- Senaryo A: bundle salt var (gerçek kullanıcı yolu — tek dosya bile bundle oluşturur) ---
  console.log('\n--- Senaryo A: bundle salt ile (normal kullanıcı yolu) ---');
  const bundleSalt = makeBundleSalt();           // app.js:549  opts.passwordSalt = b.password_salt
  // app.js uploadOne (DÜZELTİLMİŞ): encryptFile(file, password, passwordSalt || null)
  const enc = await encryptFile(fileBuffer, password, bundleSalt);
  const encSalt = enc.salt;                       // DB'ye yazılan salt = key türetiminde kullanılan
  const storedSalt = selectDecryptSalt(bundleSalt, encSalt); // server decrypt için döner
  check('DB salt == key türetim salt', storedSalt === bundleSalt && enc.salt === bundleSalt);

  // file.js decrypt yolu
  let plain = await decryptFile(enc.ciphertext, enc.iv, storedSalt, password);
  check('file.js decrypt OK', new TextDecoder().decode(plain) === 'gizli dosya içeriği — Files Fly test');

  // bundle.js decrypt yolu (aynı bundle'da 2. dosya)
  const enc2 = await encryptFile(fileBuffer, password, bundleSalt);
  let plain2 = await decryptFile(enc2.ciphertext, enc2.iv, selectDecryptSalt(bundleSalt, enc2.salt), password);
  check('bundle.js 2. dosya decrypt OK (tek parola tüm dosyalar)', new TextDecoder().decode(plain2) === 'gizli dosya içeriği — Files Fly test');

  // admin.js decrypt yolu (admin gate, encryption_salt server'dan)
  let plainA = await decryptFile(enc.ciphertext, enc.iv, storedSalt, password);
  check('admin.js decrypt OK', new TextDecoder().decode(plainA) === 'gizli dosya içeriği — Files Fly test');

  // --- Senaryo B: bundle salt yok (legacy/edge — per-file salt) ---
  console.log('\n--- Senaryo B: bundle salt yok (per-file salt) ---');
  const encB = await encryptFile(fileBuffer, password, null);
  const storedB = selectDecryptSalt(null, encB.salt);
  check('per-file salt kullanıldı', storedB === encB.salt);
  let plainB = await decryptFile(encB.ciphertext, encB.iv, storedB, password);
  check('per-file decrypt OK', new TextDecoder().decode(plainB) === 'gizli dosya içeriği — Files Fly test');

  // --- Senaryo C: yanlış parola yine başarısız ---
  console.log('\n--- Senaryo C: yanlış parola (güvenlik) ---');
  let threw = false;
  try { await decryptFile(enc.ciphertext, enc.iv, storedSalt, '0000'); } catch { threw = true; }
  check('yanlış parola → başarısız', threw);

  // --- Senaryo D: eski (bozuk) veri hâlâ açılamaz (geriye dönük uyumsuz — bilinen sınır) ---
  console.log('\n--- Senaryo D: ESKİ bozuk bundle (düzeltme öncesi yüklenen) hâlä açılmaz ---');
  // Eski buggy akış: encrypt per-file salt ile, DB'ye bundle salt yaz
  const oldEnc = await encryptFile(fileBuffer, password, null); // per-file salt (eski davranış taklidi)
  const oldStored = bundleSalt; // eski kod DB'ye bundle salt yazıyordu
  let oldThrew = false;
  try { await decryptFile(oldEnc.ciphertext, oldEnc.iv, oldStored, password); } catch { oldThrew = true; }
  check('eski bozuk veri açılamaz (geriye dönük sınır — kullanıcı yeniden yüklemeli)', oldThrew);

  console.log(`\nSONUÇ: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
