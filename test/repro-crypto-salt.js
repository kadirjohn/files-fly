/**
 * repro-crypto-salt.js — Bug kanıtı (systematic-debugging Phase 3/4)
 *
 * crypto.js mantığını Node webcrypto ile birebir taklit eder:
 *   - Mevcut (BUGGY) bundle akışı: encrypt per-file salt ile key türet,
 *     ama server'a bundle salt gönder → decrypt bundle salt ile → FAIL.
 *   - DÜZELTİLMİŞ akış: encrypt bundle salt ile key türet → decrypt bundle salt → OK.
 *
 * Çalıştır: node test/repro-crypto-salt.js
 */
const { webcrypto: { subtle } } = require('crypto');

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function bufferToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function deriveKey(password, salt, keyUsage) {
  const keyMaterial = await subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    keyUsage
  );
}

// crypto.js encryptFile'inin BİREBİR taklidi: kendi per-file salt'ını üretir.
async function encryptFileAsCodeDoes(fileBuffer, password) {
  const salt = webcryptoRandom(SALT_LENGTH);
  const aesKey = await deriveKey(password, salt, ['encrypt']);
  const iv = webcryptoRandom(IV_LENGTH);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileBuffer);
  return { ciphertext, iv: bufferToBase64(iv), salt: bufferToBase64(salt) };
}

async function decryptFile(ciphertext, ivB64, saltB64, password) {
  const iv = base64ToBytes(ivB64);
  const salt = base64ToBytes(saltB64);
  const aesKey = await deriveKey(password, salt, ['decrypt']);
  try {
    return await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  } catch {
    throw new Error('Şifre çözme başarısız. Parola yanlış olabilir.');
  }
}

function webcryptoRandom(n) {
  const a = new Uint8Array(n);
  require('crypto').webcrypto.getRandomValues(a);
  return a;
}

(async () => {
  const password = '1234';
  const fileBuffer = new TextEncoder().encode('gizli dosya içeriği — Files Fly test');

  // Server'ın ürettiği bundle salt (bundle-service.js: randomBytes(16).base64)
  const bundleSalt = bufferToBase64(webcryptoRandom(SALT_LENGTH));

  console.log('=== MEVCUT AKIŞ (buggy) — app.js uploadOne mantığı ===');
  {
    const enc = await encryptFileAsCodeDoes(fileBuffer, password);
    // app.js:619 → encSalt = passwordSalt || enc.salt  (bundle salt override)
    const encSaltSentToServer = bundleSalt; // passwordSalt wins
    console.log('  encrypt sırasında kullanılan salt (per-file):', enc.salt.slice(0, 16) + '…');
    console.log('  servera gönderilen & DBde saklanan salt     :', encSaltSentToServer.slice(0, 16) + '…');
    console.log('  Aynı salt mı?', enc.salt === encSaltSentToServer ? 'EVET' : 'HAYIR ← key farkı');
    try {
      await decryptFile(enc.ciphertext, enc.iv, encSaltSentToServer, password);
      console.log('  Sonuç: DECRYPT BAŞARILI (beklenmeyen — bug yok?)');
    } catch (e) {
      console.log('  Sonuç: DECRYPT BAŞARISIZ →', e.message);
      console.log('  ↑ Parola doğru olmasına rağmen salt uyuşmazlığı yüzünden çözemiyor');
    }
  }

  console.log('\n=== DÜZELTİLMİŞ AKIŞ — encrypt, bundle salt ile key türetmeli ===');
  {
    // Düzeltme: encryptFile'e dışarıdan salt ver → key bundle salt ile türetilsin
    const salt = base64ToBytes(bundleSalt);
    const aesKey = await deriveKey(password, salt, ['encrypt']);
    const iv = webcryptoRandom(IV_LENGTH);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileBuffer);
    const ivB64 = bufferToBase64(iv);
    const encSaltSentToServer = bundleSalt; // DBde bu saklanıyor
    console.log('  encrypt sırasında kullanılan salt (bundle):', bundleSalt.slice(0, 16) + '…');
    console.log('  servera gönderilen & DBde saklanan salt   :', encSaltSentToServer.slice(0, 16) + '…');
    try {
      const plain = await decryptFile(ciphertext, ivB64, encSaltSentToServer, password);
      console.log('  Sonuç: DECRYPT BAŞARILI →', JSON.stringify(new TextDecoder().decode(plain)));
    } catch (e) {
      console.log('  Sonuç: DECRYPT BAŞARISIZ →', e.message);
    }
  }

  console.log('\n=== Kontrol: yanlış parola her halükârda başarısız olmalı ===');
  {
    const salt = base64ToBytes(bundleSalt);
    const aesKey = await deriveKey(password, salt, ['encrypt']);
    const iv = webcryptoRandom(IV_LENGTH);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileBuffer);
    try {
      await decryptFile(ciphertext, bufferToBase64(iv), bundleSalt, '0000');
      console.log('  Sonuç: DECRYPT BAŞARILI (HATA — yanlış parola açılmamalı!)');
    } catch (e) {
      console.log('  Sonuç: DECRYPT BAŞARISIZ (doğru) →', e.message);
    }
  }
})();
