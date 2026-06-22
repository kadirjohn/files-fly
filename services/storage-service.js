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
};
