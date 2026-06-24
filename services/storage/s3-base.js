/**
 * s3-base.js — S3-Compatible Object Storage Base Class
 *
 * Hem Cloudflare R2 hem de Supabase Storage, AWS S3 protokolünü (S3 API)
 * destekler. Bu yüzden ortak mantık (putObject, getObjectStream, deleteObject,
 * presigned URL üretimi) burada toplanır. Provider'lar sadece:
 *   - endpoint / region / forcePathStyle ayarları
 *   - public URL template'i (getPublicUrl)
 *   - presigned URL imza ayarları
 * bakımından farklıdır.
 *
 * AWS SDK v3 (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner) kullanır.
 * Bu paketler opsiyoneldir — yüklü değilse provider yüklenmez ve factory
 * local'e düşer. Bu sayede ana proje "zero-dependency" prensibini korur:
 * S3 provider'ları yalnızca kullanılmak istendiğinde devreye girer.
 */

// AWS SDK lazy-load — bağımlılık yoksa bu modül require edilemez (factory
// try/catch ile yükler).
let S3ClientCtor = null;
let GetObjectCommandCtor = null;
let PutObjectCommandCtor = null;
let DeleteObjectCommandCtor = null;
let HeadObjectCommandCtor = null;
let UploadClass = null;
let getSignedUrlFn = null;
let sdkLoadError = null;

function loadS3Sdk() {
  if (S3ClientCtor) return true;
  if (sdkLoadError) return false;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
    const { Upload } = require('@aws-sdk/lib-storage');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    S3ClientCtor = S3Client;
    GetObjectCommandCtor = GetObjectCommand;
    PutObjectCommandCtor = PutObjectCommand;
    DeleteObjectCommandCtor = DeleteObjectCommand;
    HeadObjectCommandCtor = HeadObjectCommand;
    UploadClass = Upload;
    getSignedUrlFn = getSignedUrl;
    return true;
  } catch (err) {
    sdkLoadError = err;
    console.warn('[Storage:S3] AWS SDK v3 yüklenemedi. @aws-sdk/client-s3, @aws-sdk/lib-storage, @aws-sdk/s3-request-presigner paketlerini yükleyin.', err.message);
    return false;
  }
}

// Node web stream → Node readable stream dönüşümü (SDK body web stream döner)
function webStreamToNodeStream(webStream) {
  const { Readable } = require('stream');
  if (webStream && typeof webStream.getReader === 'function') {
    const reader = webStream.getReader();
    return new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) { this.push(null); return; }
          this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err);
        }
      },
    });
  }
  return webStream; // zaten Node stream
}

class S3BaseStorageProvider {
  constructor(config = {}) {
    if (!loadS3Sdk()) {
      throw new Error(`AWS SDK v3 yüklenemedi — S3-uyumlu provider kullanılamaz. (${sdkLoadError && sdkLoadError.message})`);
    }
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.region = config.region || 'auto';
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.forcePathStyle = config.forcePathStyle !== false; // R2/Supabase için true (domain değil path)
    this.publicBaseUrl = config.publicBaseUrl || null; // https://<bucket>.r2.dev gibi
    this.presignExpiresIn = config.presignExpiresIn || 3600; // saniye (1 saat)

    if (!this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error(`${this.name}: bucket, accessKeyId, secretAccessKey zorunludur.`);
    }

    this.client = new S3ClientCtor({
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
      forcePathStyle: this.forcePathStyle,
    });
  }

  get isCloud() { return true; }

  async ensureReady() {
    // S3-uyumlu bucket'lar önceden oluşturulur; burada bağlantıyı test et.
    // Hata fırlatmıyoruz — ilk işlemde gerçek hata ortaya çıkar.
  }

  /**
   * Dosyayı bucket'a yükler. Buffer veya stream kabul eder.
   * @param {string} key
   * @param {Buffer|NodeJS.ReadableStream} data
   * @param {{ contentType?: string, contentLength?: number }} opts
   */
  async putObject(key, data, opts = {}) {
    const contentType = opts.contentType || 'application/octet-stream';

    if (Buffer.isBuffer(data)) {
      const command = new PutObjectCommandCtor({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      });
      await this.client.send(command);
      return;
    }

    if (data && typeof data.pipe === 'function') {
      const S5MB = 5 * 1024 * 1024;

      // 5 MB ve altı dosyalar tek parça PutObject (Supabase free tier tek parça
      // limiti 5 MB; daha büyük dosyalar için multipart zorunlu).
      if (opts.contentLength && Number.isFinite(opts.contentLength) && opts.contentLength > 0 && opts.contentLength <= S5MB) {
        const command = new PutObjectCommandCtor({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          ContentLength: opts.contentLength,
        });
        await this.client.send(command);
        return;
      }

      // Büyük dosyalar: multipart upload. Supabase free tier'da 5 MB part size
      // ve sıralı (queueSize: 1) gönderim daha güvenlidir; paralel part gönderim
      // "upload does not exist" hatasına yol açabiliyor.
      const upload = new UploadClass({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        },
        queueSize: 1,
        partSize: S5MB, // 5 MB part
      });
      await upload.done();
      return;
    }

    throw new Error(`${this.name}.putObject: data must be Buffer or ReadStream`);
  }

  /**
   * Dosyayı stream olarak okur. Range destekli (video resume için).
   * @param {string} key
   * @param {{ start?: number, end?: number }|null} range
   * @returns {Promise<{ stream: NodeJS.ReadableStream, size: number }>}
   */
  async getObjectStream(key, range = null) {
    const input = { Bucket: this.bucket, Key: key };
    if (range && (range.start != null || range.end != null)) {
      const start = range.start != null ? range.start : 0;
      const end = range.end != null ? range.end : ''; // boş = dosya sonuna
      input.Range = `bytes=${start}-${end}`;
    }

    // Önce boyutu al (range yoksa tüm dosya; range varsa bu chunk)
    let totalSize = await this.getSize(key);

    const command = new GetObjectCommandCtor(input);
    const response = await this.client.send(command);

    const body = response.Body;
    const stream = webStreamToNodeStream(body);

    // Range varsa ContentRange'den gerçek chunk boyutu, yoksa totalSize
    let reportedSize = totalSize;
    if (response.ContentRange) {
      // bytes 0-1023/2048 → 2048
      const m = response.ContentRange.match(/\/(\d+)/);
      if (m) reportedSize = parseInt(m[1]);
    }

    return { stream, size: reportedSize };
  }

  /**
   * Dosyayı tamamen Buffer olarak okur (text preview / thumbnail kaynağı).
   * @param {string} key
   * @returns {Promise<Buffer>}
   */
  async getObjectBuffer(key) {
    const command = new GetObjectCommandCtor({ Bucket: this.bucket, Key: key });
    const response = await this.client.send(command);
    const body = response.Body;
    if (Buffer.isBuffer(body)) return body;
    if (body && typeof body.transformToByteArray === 'function') {
      const arr = await body.transformToByteArray();
      return Buffer.from(arr);
    }
    // Web/Node stream → buffer
    const chunks = [];
    const stream = webStreamToNodeStream(body);
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /**
   * Dosyayı bucket'tan siler.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async deleteObject(key) {
    const command = new DeleteObjectCommandCtor({ Bucket: this.bucket, Key: key });
    try {
      await this.client.send(command);
      console.log(`[DELETE] OK backend=${this.name} bucket=${this.bucket} key=${key}`);
      return true;
    } catch (err) {
      if (err && err.name === 'NoSuchKey') {
        console.log(`[DELETE] NoSuchKey (zaten yok) bucket=${this.bucket} key=${key}`);
        return false;
      }
      console.error(`[DELETE] FAIL backend=${this.name} bucket=${this.bucket} key=${key} err=${err && err.name}: ${err && err.message}`);
      throw err;
    }
  }

  /**
   * Dosya var mı? (HeadObject)
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    const command = new HeadObjectCommandCtor({ Bucket: this.bucket, Key: key });
    try {
      await this.client.send(command);
      return true;
    } catch (err) {
      if (err && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata && err.$metadata.httpStatusCode === 404)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Dosya boyutu (ContentLength).
   * @param {string} key
   * @returns {Promise<number>}
   */
  async getSize(key) {
    const command = new HeadObjectCommandCtor({ Bucket: this.bucket, Key: key });
    const response = await this.client.send(command);
    return response.ContentLength || 0;
  }

  /**
   * Private bucket için presigned GET URL üretir (süreli indirme linki).
   * Frontend doğrudan bu URL'ye yönlendirilir → sunucu trafiği düşer.
   * @param {string} key
   * @param {{ expiresIn?: number, responseContentType?: string, responseContentDisposition?: string }} opts
   * @returns {Promise<string>}
   */
  async getDownloadUrl(key, opts = {}) {
    const expiresIn = opts.expiresIn || this.presignExpiresIn;
    const input = { Bucket: this.bucket, Key: key };
    if (opts.responseContentType) input.ResponseContentType = opts.responseContentType;
    if (opts.responseContentDisposition) input.ResponseContentDisposition = opts.responseContentDisposition;
    const command = new GetObjectCommandCtor(input);
    return getSignedUrlFn(this.client, command, { expiresIn });
  }

  /**
   * Önizleme (inline görüntüleme) için presigned URL.
   * Download'dan farkı: Content-Disposition inline → tarayıcı gösterir, indirmez.
   */
  async getPreviewUrl(key, opts = {}) {
    return this.getDownloadUrl(key, {
      ...opts,
      responseContentDisposition: `inline`,
    });
  }
}

module.exports = {
  S3BaseStorageProvider,
  loadS3Sdk,
  webStreamToNodeStream,
};
