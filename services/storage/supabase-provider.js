/**
 * supabase-provider.js — Supabase Storage Object Storage Provider
 *
 * Supabase Storage, S3-uyumlu bir bucket servisidir. Supabase projelerinde
 * "Storage" sekmesinden bucket oluşturulur ve S3 connection info
 * (S3 Connection / Edge URL, access key, secret) alınır.
 *
 * Yapılandırma (env vars):
 *   SUPABASE_S3_ENDPOINT     - https://<project>.supabase.co/storage/v1/s3
 *   SUPABASE_S3_REGION       - genelde "us-east-1" (Supabase docs)
 *   SUPABASE_S3_ACCESS_KEY_ID
 *   SUPABASE_S3_SECRET_ACCESS_KEY
 *   SUPABASE_S3_BUCKET       - bucket adı (Supabase Storage'da oluşturulan)
 *   SUPABASE_S3_PUBLIC_BASE_URL - (opsiyonel) public URL base:
 *                              https://<project>.supabase.co/storage/v1/object/public/
 *
 * Not: Supabase S3 API'si path-style bekler (forcePathStyle: true).
 *
 * Alternative: Supabase JS SDK (@supabase/supabase-js) ile REST API
 * kullanılabilir, ancak S3-uyumlu endpoint kullanmak tek abstraction
 * (s3-base) üzerinden R2 ile aynı kodu paylaşmamızı sağlar — daha az
 * bağımlılık, daha az bakım.
 */

const { S3BaseStorageProvider } = require('./s3-base');

class SupabaseStorageProvider extends S3BaseStorageProvider {
  constructor(config = {}) {
    const endpoint = config.endpoint || process.env.SUPABASE_S3_ENDPOINT;
    if (!endpoint) {
      throw new Error('Supabase: SUPABASE_S3_ENDPOINT zorunludur (örn: https://<project>.supabase.co/storage/v1/s3).');
    }

    super({
      bucket: config.bucket || process.env.SUPABASE_S3_BUCKET,
      endpoint,
      region: config.region || process.env.SUPABASE_S3_REGION || 'us-east-1',
      accessKeyId: config.accessKeyId || process.env.SUPABASE_S3_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.SUPABASE_S3_SECRET_ACCESS_KEY,
      forcePathStyle: true, // Supabase S3 path-style ister
      publicBaseUrl: config.publicBaseUrl || process.env.SUPABASE_S3_PUBLIC_BASE_URL || null,
      // presignExpiresIn: artık buradan set edilmez. İndirme linkinin ömrü
      // kullanıcının seçtiği expire süresinden (files.expire_at - now) türetilir
      // — bkz. services/download-service.js. s3-base.js default (3600) defense-in-depth kalır.
    });
  }

  get name() { return 'supabase'; }
}

module.exports = { SupabaseStorageProvider };
