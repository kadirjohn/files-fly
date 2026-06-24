/**
 * crypto.js — Files Fly Paylaşımlı Şifreleme Yardımcıları
 *
 * Web Crypto API tabanlı AES-GCM + PBKDF2 parola koruması.
 * app.js (yükleme), file.js (önizleme/indirme) ve admin.js (panel) tarafından
 * ortak kullanılır — kod tekrarını önlemek için tek bir yerde tutulur.
 *
 * Akış:
 *   encryptFile(file, password) → { ciphertext: Blob, iv: string, salt: string }
 *   decryptFile(ciphertext, ivBase64, saltBase64, password) → ArrayBuffer
 *
 * IV: 12 byte (AES-GCM standardı), Salt: 16 byte, PBKDF2: 100.000 iterasyon, SHA-256.
 */

// Global namespace — sayfaya script sırasıyla dahil edildikten sonra kullanılır.
window.FFCrypto = (function () {
  'use strict';

  const PBKDF2_ITERATIONS = 100000;
  const SALT_LENGTH = 16;
  const IV_LENGTH = 12;

  /**
   * Paroladan PBKDF2 ile AES-256-GCM key türetir.
   * @param {string} password
   * @param {BufferSource} salt
   * @param {string[]} keyUsage - ['encrypt'] veya ['decrypt']
   * @returns {Promise<CryptoKey>}
   */
  async function deriveKey(password, salt, keyUsage) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      keyUsage
    );
  }

  /**
   * Dosyayı AES-GCM ile şifreler.
   * @param {File|Blob} file
   * @param {string} password
   * @param {string} [saltBase64] - Opsiyonel: key türetmek için kullanılacak salt
   *   (bundle ortak salt gibi). Verilmezse per-file random salt üretilir.
   *   KRİTİK: decrypt'in aynı salt'la key türetmesi gerekir — aksi halde parola
   *   doğru olsa bile AES-GCM auth-tag uyuşmaz → "Parola yanlış olabilir" hatası.
   *   (Bundle akışı: tek parola tüm dosyaları açsın diye tüm dosyalar aynı salt'la
   *    key türetmelidir; encrypt'in kendi per-file salt'ını DB'deki bundle salt'la
   *    değiştirmek yetmez — key'i de o salt'la türetmek şarttır.)
   * @returns {Promise<{ciphertext: Blob, iv: string, salt: string}>}
   */
  async function encryptFile(file, password, saltBase64) {
    // 1. Salt: dışarıdan verilmişse onu kullan (bundle ortak salt), yoksa per-file random.
    const salt = saltBase64 ? base64ToBuffer(saltBase64) : crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

    // 2. PBKDF2 ile key türet (kullanılan salt ile — decrypt de bunu kullanacak)
    const aesKey = await deriveKey(password, salt, ['encrypt']);

    // 3. IV (12 byte — AES-GCM standardı)
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // 4. Dosyayı ArrayBuffer olarak oku
    const fileBuffer = await file.arrayBuffer();

    // 5. AES-GCM ile şifrele
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      aesKey,
      fileBuffer
    );

    // 6. (salt, iv) base64 + ciphertext Blob
    return {
      ciphertext: new Blob([ciphertext], { type: 'application/octet-stream' }),
      iv: bufferToBase64(iv),
      salt: bufferToBase64(salt),
    };
  }

  /**
   * Şifreli dosyayı AES-GCM ile çözer.
   * @param {ArrayBuffer} ciphertext - Şifreli veri
   * @param {string} ivBase64 - Base64 IV
   * @param {string} saltBase64 - Base64 salt
   * @param {string} password - Parola
   * @returns {Promise<ArrayBuffer>} - Çözülmüş dosya içeriği
   */
  async function decryptFile(ciphertext, ivBase64, saltBase64, password) {
    const iv = base64ToBuffer(ivBase64);
    const salt = base64ToBuffer(saltBase64);

    const aesKey = await deriveKey(password, salt, ['decrypt']);

    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        ciphertext
      );
    } catch (err) {
      throw new Error('Şifre çözme başarısız. Parola yanlış olabilir.');
    }
  }

  // -------------------------------------------------------------------------
  // Base64 yardımcıları
  // -------------------------------------------------------------------------

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  return {
    encryptFile,
    decryptFile,
    bufferToBase64,
    base64ToBuffer,
  };
})();
