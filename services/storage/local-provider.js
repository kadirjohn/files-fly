/**
 * local-provider.js — Yerel Disk Object Storage Provider
 *
 * Dosyaları sunucunun diskinde (UPLOADS_DIR) saklar. "Bucket" mantığının
 * yerel karşılığıdır: dosya içeriği diske, metadata (key) veritabanına yazılır.
 *
 * Cloud provider'larından farkı:
 *   - getDownloadUrl() → null döner (cloud gibi presigned URL yok)
 *     → çağıran taraf (download-service) içeriği sunucu üzerinden stream eder
 *   - Range destekli gerçek streaming (video resume, partial download)
 *
 * Bu provider AWS S3 / R2 / Supabase ile aynı arayüzü uyguladığı için,
 * yapılandırmayı değiştirmeden backend'ler arası geçiş yapılabilir.
 */

const fs = require('fs');
const path = require('path');

class LocalStorageProvider {
  constructor(config = {}) {
    this.uploadsDir = config.uploadsDir || process.env.UPLOADS_DIR || '/data/uploads';
  }

  get name() { return 'local'; }
  get isCloud() { return false; }

  /**
   * Key'i (örn: "abc-123.mp4") mutlak disk yoluna çevirir.
   * @param {string} key
   * @returns {string}
   * @private
   */
  _resolve(key) {
    // Güvenlik: key içinde path traversal olmamalı (sadece dosya adı beklenir)
    const safe = path.basename(key);
    return path.join(this.uploadsDir, safe);
  }

  async ensureReady() {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
      console.log(`[Storage:local] Created uploads directory: ${this.uploadsDir}`);
    }
  }

  /**
   * Dosyayı diske yazar.
   * @param {string} key - Object key (örn: "abc-123.mp4")
   * @param {Buffer|fs.ReadStream|NodeJS.ReadableStream} data - İçerik
   * @param {{ contentType?: string }} opts
   */
  async putObject(key, data, opts = {}) {
    const filePath = this._resolve(key);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Buffer → direkt yaz
    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(filePath, data);
      return;
    }

    // Stream → pipe ile yaz (büyük dosyalar için bellek dostu)
    if (data && typeof data.pipe === 'function') {
      const writeStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        data.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        data.on('error', reject);
      });
      return;
    }

    throw new Error('local.putObject: data must be Buffer or ReadStream');
  }

  /**
   * Dosyayı stream olarak okur (Range destekli).
   * @param {string} key
   * @param {{ start?: number, end?: number }|null} range
   * @returns {Promise<{ stream: fs.ReadStream, size: number }>}
   */
  async getObjectStream(key, range = null) {
    const filePath = this._resolve(key);
    const stat = await fs.promises.stat(filePath);
    const size = stat.size;

    const options = {};
    if (range && range.start != null) options.start = range.start;
    if (range && range.end != null) options.end = range.end;

    const stream = fs.createReadStream(filePath, options);
    return { stream, size };
  }

  /**
   * Dosyayı tamamen Buffer olarak okur (text preview / thumbnail kaynağı için).
   * @param {string} key
   * @returns {Promise<Buffer>}
   */
  async getObjectBuffer(key) {
    const filePath = this._resolve(key);
    return fs.promises.readFile(filePath);
  }

  /**
   * Dosyayı diskten siler.
   * @param {string} key
   * @returns {Promise<boolean>} - Vardı ve silindiyse true
   */
  async deleteObject(key) {
    const filePath = this._resolve(key);
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Dosyanın varlığını kontrol eder.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    const filePath = this._resolve(key);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dosya boyutunu döndürür (byte).
   * @param {string} key
   * @returns {Promise<number>}
   */
  async getSize(key) {
    const filePath = this._resolve(key);
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  }

  /**
   * Local provider presigned/public URL desteklemez → null.
   * Çağıran taraf bu durumda sunucu üzerinden stream etmek zorundadır.
   * @returns {null}
   */
  async getDownloadUrl(/* key, opts */) {
    return null;
  }

  async getPreviewUrl(/* key, opts */) {
    return null;
  }
}

module.exports = { LocalStorageProvider };
