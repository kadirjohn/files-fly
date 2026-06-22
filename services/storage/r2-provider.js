/**
 * r2-provider.js — Cloudflare R2 Object Storage Provider
 *
 * Cloudflare R2, AWS S3 protokolünü destekleyen bir "Object Storage" bucket
 * servisidir. Çıkış trafiği (egress) ücretsiz olduğu için dosya paylaşım
 * platformları için idealdir.
 *
 * Yapılandırma (env vars):
 *   R2_ACCOUNT_ID       - Cloudflare account ID (R2 dashboard'da görünür)
 *   R2_ACCESS_KEY_ID    - R2 API token'ından üretilen access key
 *   R2_SECRET_ACCESS_KEY- R2 secret key
 *   R2_BUCKET_NAME      - Bucket adı
 *   R2_PUBLIC_BASE_URL  - (opsiyonel) public bucket URL: https://<id>.r2.dev
 *                         veya custom domain. Verilirse public dosyalar için
 *                         presigned URL yerine bu URL kullanılır.
 *
 * Endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 * Region   : "auto" (R2 tek region mantığı kullanır)
 */

const { S3BaseStorageProvider } = require('./s3-base');

class R2StorageProvider extends S3BaseStorageProvider {
  constructor(config = {}) {
    const accountId = config.accountId || process.env.R2_ACCOUNT_ID;
    if (!accountId) {
      throw new Error('R2: R2_ACCOUNT_ID zorunludur.');
    }

    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    super({
      bucket: config.bucket || process.env.R2_BUCKET_NAME,
      endpoint,
      region: 'auto',
      accessKeyId: config.accessKeyId || process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY,
      forcePathStyle: true, // R2 path-style ister
      publicBaseUrl: config.publicBaseUrl || process.env.R2_PUBLIC_BASE_URL || null,
      presignExpiresIn: config.presignExpiresIn || parseInt(process.env.R2_PRESIGN_EXPIRES_IN || '3600', 10),
    });
  }

  get name() { return 'r2'; }
}

module.exports = { R2StorageProvider };
