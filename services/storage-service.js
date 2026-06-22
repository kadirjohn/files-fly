/**
 * storage-service.js — Yerel Dosya Depolama Servisi
 * 
 * Dosya okuma, yazma, silme işlemleri.
 * Tüm dosyalar /data/uploads/ altında UUID isimlerle saklanır.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
// Thumbnail cache dizini — admin image preview için küçültülmüş imajlar burada saklanır.
// Docker'da /data/thumbs, local geliştirmede uploads dizininin yanında ./thumbs
const THUMBS_DIR = process.env.THUMBS_DIR || (UPLOADS_DIR === '/data/uploads' ? '/data/thumbs' : path.join(UPLOADS_DIR, '..', 'thumbs'));

// =========================================================================
// Temel İşlemler
// =========================================================================

/**
 * Dosyayı diske yazar.
 * @param {string} storagePath - Hedef dosya yolu (örn: /data/uploads/abc123.mp4)
 * @param {Buffer|string} data - Dosya içeriği
 * @returns {Promise<void>}
 */
async function writeFile(storagePath, data) {
  const dir = path.dirname(storagePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await fs.promises.writeFile(storagePath, data);
}

/**
 * Dosyayı stream olarak okur (Range header destekli).
 * @param {string} storagePath
 * @param {number|null} start - Başlangıç byte'ı (Range)
 * @param {number|null} end - Bitiş byte'ı (Range)
 * @returns {Promise<{stream: fs.ReadStream, size: number}>}
 */
async function readFileStream(storagePath, start = null, end = null) {
  const stat = await fs.promises.stat(storagePath);
  const fileSize = stat.size;

  const options = {};
  if (start !== null) options.start = start;
  if (end !== null) options.end = end;

  const stream = fs.createReadStream(storagePath, options);
  return { stream, size: fileSize };
}

/**
 * Dosyayı tamamen okur (Buffer olarak).
 * @param {string} storagePath
 * @returns {Promise<Buffer>}
 */
async function readFile(storagePath) {
  return fs.promises.readFile(storagePath);
}

/**
 * Dosyayı diskten siler.
 * @param {string} storagePath
 * @returns {Promise<boolean>} - Başarılıysa true
 */
async function deleteFile(storagePath) {
  try {
    await fs.promises.unlink(storagePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false; // Dosya zaten yok
    }
    throw err;
  }
}

/**
 * Dosyanın var olup olmadığını kontrol eder.
 * @param {string} storagePath
 * @returns {Promise<boolean>}
 */
async function fileExists(storagePath) {
  try {
    await fs.promises.access(storagePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dosya boyutunu döndürür.
 * @param {string} storagePath
 * @returns {Promise<number>}
 */
async function getFileSize(storagePath) {
  const stat = await fs.promises.stat(storagePath);
  return stat.size;
}

// =========================================================================
// Upload Dizini Yönetimi
// =========================================================================

/**
 * Upload dizininin var olduğundan emin olur.
 */
async function ensureUploadDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log(`[Storage] Created uploads directory: ${UPLOADS_DIR}`);
  }
}

// =========================================================================
// Thumbnail Dizini Yönetimi (Image Preview)
// =========================================================================
// ÖNEMLİ: Thumbnail'lar artık tek bir düz klasörde DEĞİL, dosya ID'sinin
// ilk hex karakterlerine göre alt klasörlenmiş olarak saklanır (sub-directory
// hashing). Bu, 10k+ dosyada ext4/APFS'in readdir/stat I/O darboğazını önler.
//   fileId = "a1b2c3d4-..."
//   → /data/thumbs/a1/b2/a1b2c3d4-....jpg     (256×256 = 65,536 bucket)
//   → /data/thumbs/a1/b2/a1b2c3d4-....fail    (negative cache marker)

/**
 * Thumbnail cache dizininin var olduğundan emin olur (en üst seviye).
 * Alt klasörler generateThumbnail sırasında { recursive: true } ile oluşturulur.
 */
async function ensureThumbsDir() {
  if (!fs.existsSync(THUMBS_DIR)) {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    console.log(`[Storage] Created thumbs directory: ${THUMBS_DIR}`);
  }
}

/**
 * Dosya ID'sinden thumbnail alt dizin yolunu hesaplar (sub-directory hashing).
 * İlk 2 ve sonraki 2 hex karakteri kullanılır: /data/thumbs/<hex0-1>/<hex2-3>/
 *
 * @param {string} fileId - Dosya UUID'si (örn: "a1b2c3d4-...")
 * @returns {{ dir: string, prefix: string }} - { dir: alt dizin yolu, prefix: "a1/b2" }
 */
function getThumbSubDir(fileId) {
  const hex = String(fileId || '').replace(/-/g, '').toLowerCase();
  const a = hex.substring(0, 2) || '00';
  const b = hex.substring(2, 4) || '00';
  return { dir: path.join(THUMBS_DIR, a, b), prefix: `${a}/${b}` };
}

/**
 * Thumbnail alt dizininin var olduğundan emin olur (thumbnail yazılmadan önce).
 * @param {string} fileId - Alt dizini hesaplamak için
 * @returns {Promise<string>} - Oluşturulan/olan dizin yolu
 */
async function ensureThumbSubDir(fileId) {
  const { dir } = getThumbSubDir(fileId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Bir dosya ID'si için thumbnail dosya yolunu döndürür (sub-directory hashed).
 * JPEG formatında saklanır.
 * @param {string} fileId - Dosya UUID'si
 * @returns {string} - Örn: /data/thumbs/a1/b2/a1b2c3d4-....jpg
 */
function getThumbPath(fileId) {
  const { dir } = getThumbSubDir(fileId);
  return path.join(dir, `${fileId}.jpg`);
}

/**
 * Negative cache marker dosya yolunu döndürür.
 * Thumbnail üretimi başarısız olursa 0 byte'lık bu marker yazılır;
 * sonraki /thumb istekleri marker'ı görüp sharp'ı tekrar tetiklemeden
 * 404 döner (DoS önlemi — bozuk imaja sürekli istek atılmasını engeller).
 *
 * @param {string} fileId
 * @returns {string} - Örn: /data/thumbs/a1/b2/a1b2c3d4-....fail
 */
function getThumbFailMarkerPath(fileId) {
  const { dir } = getThumbSubDir(fileId);
  return path.join(dir, `${fileId}.fail`);
}

/**
 * Thumbnail cache'ini temizler (dosya silindiğinde / süresi dolduğunda çağrılır).
 * Hem .jpg thumbnail'i hem de .fail negative cache marker'ını siler.
 * @param {string} fileId
 */
async function deleteThumb(fileId) {
  const thumbPath = getThumbPath(fileId);
  const failPath = getThumbFailMarkerPath(fileId);
  let removed = false;
  for (const p of [thumbPath, failPath]) {
    try {
      await fs.promises.unlink(p);
      removed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Yok → sessizce geç
    }
  }
  return removed;
}

/**
 * Upload dizinindeki toplam dosya boyutunu hesaplar.
 * @returns {Promise<number>} - Byte cinsinden
 */
async function getTotalUploadSize() {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;

  let totalSize = 0;
  const files = fs.readdirSync(UPLOADS_DIR);

  for (const file of files) {
    const filePath = path.join(UPLOADS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        totalSize += stat.size;
      }
    } catch {
      // Dosya silinmiş olabilir, ignore
    }
  }

  return totalSize;
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  writeFile,
  readFileStream,
  readFile,
  deleteFile,
  fileExists,
  getFileSize,
  ensureUploadDir,
  getTotalUploadSize,
  UPLOADS_DIR,
  THUMBS_DIR,
  ensureThumbsDir,
  getThumbPath,
  getThumbFailMarkerPath,
  getThumbSubDir,
  ensureThumbSubDir,
  deleteThumb,
};
