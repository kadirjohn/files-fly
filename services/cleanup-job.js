/**
 * cleanup-job.js — Süresi Dolan Dosyaları Temizleme Cron Job'u
 * 
 * setInterval ile periyodik olarak çalışır.
 * Config'deki `cleanup_interval_minutes` değerine göre sıklık ayarlanır.
 * 
 * İşlem (Bucket mantığı):
 * 1. expire_at < NOW() olan dosyaları PG'den sorgula (storage_backend + storage_key)
 * 2. Her dosyayı KENDİ backend'inden sil (provider.deleteObject)
 *    — backend değişse bile eski R2/local dosyaları doğru yere silinir
 * 3. Thumbnail cache'ini temizle (her zaman local disk)
 * 4. PG'den kaydı sil
 * 5. İstatistik logla
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const { getConfig } = require('./config-service');
const storage = require('./storage');
const { deleteThumb, THUMBS_DIR, getThumbPath, getThumbFailMarkerPath, ensureThumbSubDir } = require('./storage-service');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const TMP_DIR = process.env.CHUNK_TMP_DIR || path.join(UPLOADS_DIR, 'tmp');

// Migration flag — migrateFlatThumbs bir kez çalışsın (in-memory).
let flatThumbMigrationDone = false;

// =========================================================================
// Yapılandırma
// =========================================================================

let cleanupIntervalMs = 15 * 60 * 1000; // Varsayılan: 15 dakika
let intervalHandle = null;

// =========================================================================
// Ana Temizleme İşlemi
// =========================================================================

/**
 * Süresi dolmuş tüm dosyaları temizler.
 * @returns {Promise<{deleted: number, freedBytes: number}>}
 */
async function runCleanup() {
  const startTime = Date.now();
  let deletedCount = 0;
  let freedBytes = 0;

  try {
    // -----------------------------------------------------------------------
    // 0. Süresi dolmuş bundle'ları temizle (cascade files rows + blob silme).
    //    ÖNCE bundle cleanup → per-file sorgusu zaten-silinmiş dosyaları tekrar
    //    görmez; sadece bundle_id NULL orphan dosyaları yakalar. Bundle'ı olan
    //    dosyalar bundle.expire_at ile yönetilir (file.expire_at'dan bağımsız).
    // -----------------------------------------------------------------------
    const bundleResult = await cleanupExpiredBundles();
    freedBytes += bundleResult.freedBytes;
    if (bundleResult.bundles > 0) {
      console.log(`[Cleanup] Deleted ${bundleResult.bundles} expired bundle(s), ${formatBytes(bundleResult.freedBytes)} freed.`);
    }

    // -----------------------------------------------------------------------
    // 1. Süresi dolmuş dosyaları PG'den sorgula
    //    storage_backend + storage_key (artık storage_path yok)
    // -----------------------------------------------------------------------
    const result = await query(
      `SELECT id, storage_backend, storage_key, file_size, filename
       FROM files
       WHERE expire_at < NOW()
       ORDER BY expire_at ASC
       LIMIT 1000` // Tek seferde max 1000 dosya (batch processing)
    );

    const expiredFiles = result.rows;

    if (expiredFiles.length === 0) {
      // Hiç süresi dolmuş dosya yok
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[Cleanup] No expired files found. (checked in ${Date.now() - startTime}ms)`);
      }
      return { deleted: 0, freedBytes: 0 };
    }

    console.log(`[Cleanup] Found ${expiredFiles.length} expired file(s). Cleaning up...`);

    // -----------------------------------------------------------------------
    // 2. Her dosyayı kendi backend'inden sil ve PG'den kaldır
    // -----------------------------------------------------------------------
    for (const file of expiredFiles) {
      try {
        // Object Storage'dan sil (backend'e göre doğru provider)
        if (file.storage_key) {
          try {
            const provider = await storage.getProviderForFile(file);
            await provider.deleteObject(file.storage_key);
            freedBytes += parseInt(file.file_size) || 0;
          } catch (delErr) {
            console.error(`[Cleanup] Error deleting object ${file.storage_key} from ${file.storage_backend}:`, delErr.message);
            // Nesne silinmese bile DB kaydını sil (orphan blob uyarısı logla)
          }
        }

        // Thumbnail cache'ini de temizle (image dosyaları için, her zaman local)
        try {
          await deleteThumb(file.id);
        } catch (err) {
          // Thumbnail yoksa veya silinemezse kritik değil
        }

        // PG'den sil
        await query(`DELETE FROM files WHERE id = $1`, [file.id]);

        deletedCount++;
      } catch (err) {
        console.error(`[Cleanup] Error deleting file ${file.id} (${file.filename}):`, err.message);

        // Provider hatasında bile DB kaydını silmeyi dene (orphan kayıt)
        try {
          await query(`DELETE FROM files WHERE id = $1`, [file.id]);
          deletedCount++;
        } catch (dbErr) {
          console.error(`[Cleanup] Error removing orphan record ${file.id}:`, dbErr.message);
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. Boş kalan geçici chunk dizinlerini temizle
    // -----------------------------------------------------------------------
    await cleanupOrphanChunkDirs();

    // -----------------------------------------------------------------------
    // 4. Log
    // -----------------------------------------------------------------------
    const elapsed = Date.now() - startTime;
    console.log(`[Cleanup] Done: ${deletedCount} file(s) deleted, ${formatBytes(freedBytes)} freed, took ${elapsed}ms`);

    return { deleted: deletedCount, freedBytes };
  } catch (err) {
    console.error('[Cleanup] Fatal error during cleanup:', err.message);
    return { deleted: deletedCount, freedBytes };
  }
}

// =========================================================================
// Bundle Temizliği (Süresi Dolan Bundle'lar)
// =========================================================================

/**
 * Süresi dolmuş bundle'ları temizler.
 *
 * Bir bundle'ın expire_at'i geçtiyse tüm dosyaları da süresi dolmuş demektir
 * (file.expire_at, join durumunda bundle'ın kalan saatine ayarlanır ama bundle
 * paylaşım linkinin süresini bundle.expire_at yönetir). Bu yüzden bundle cleanup,
 * per-file cleanup'tan AYRI ve ÖNCE çalışır:
 *
 *   1. bundle'a ait tüm dosyaların storage object'lerini sil (backend'e göre
 *      doğru provider → deleteObject) — FK CASCADE satırı siler ama blob'ı SİLMEZ.
 *   2. Her dosyanın thumbnail cache'ini de temizle (per-file cleanup ile aynı).
 *   3. Bundle satırını sil → FK ON DELETE CASCADE files satırlarını da kaldırır.
 *
 * Per-file cleanup (runCleanup step 1) bundle_id NULL orphan dosyaları için
 * korunur; bundle'ı olan dosyalar burada yakalandığı için tekrar görülmez.
 *
 * @returns {Promise<{bundles: number, freedBytes: number}>}
 */
async function cleanupExpiredBundles() {
  let bundleCount = 0;
  let freedBytes = 0;

  try {
    const expired = await query(
      `SELECT id FROM bundles WHERE expire_at < NOW() ORDER BY expire_at ASC LIMIT 1000`
    );

    for (const b of expired.rows) {
      try {
        // Bu bundle'ın dosyalarının storage object'lerini sil (cascade blob'ı silmez).
        const files = await query(
          `SELECT id, storage_backend, storage_key, file_size FROM files WHERE bundle_id = $1`,
          [b.id]
        );

        for (const f of files.rows) {
          try {
            if (f.storage_key) {
              const provider = await storage.getProviderForFile(f);
              await provider.deleteObject(f.storage_key);
              freedBytes += parseInt(f.file_size) || 0;
            }
          } catch (delErr) {
            console.error(`[Cleanup] bundle ${b.id} file ${f.id} delete err:`, delErr.message);
            // Nesne silinmese bile devam et — bundle satırı silinir, orphan blob loglanır.
          }
          // Thumbnail cache'ini de temizle (image dosyaları, her zaman local).
          try { await deleteThumb(f.id); } catch { /* thumbnail yoksa kritik değil */ }
        }

        // Bundle satırını sil → FK ON DELETE CASCADE files satırlarını kaldırır.
        await query(`DELETE FROM bundles WHERE id = $1`, [b.id]);
        bundleCount++;
      } catch (err) {
        console.error(`[Cleanup] Error deleting bundle ${b.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cleanup] Fatal error during bundle cleanup:', err.message);
  }

  return { bundles: bundleCount, freedBytes };
}

// =========================================================================
// Orphan Chunk Dizin Temizliği
// =========================================================================

/**
 * /data/uploads/tmp/ altında kalmış, artık PG'de kaydı olmayan
 * chunk dizinlerini temizler. Chunk'lar HER ZAMAN local tmp'de toplanır.
 */
async function cleanupOrphanChunkDirs() {
  if (!fs.existsSync(TMP_DIR)) return;

  try {
    const dirs = fs.readdirSync(TMP_DIR);

    for (const dir of dirs) {
      const dirPath = path.join(TMP_DIR, dir);
      const stat = fs.statSync(dirPath);

      if (!stat.isDirectory()) continue;

      // 24 saatten eski chunk dizinlerini temizle
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`[Cleanup] Removed orphan chunk dir: ${dir}`);
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning orphan chunk dirs:', err.message);
  }
}

// =========================================================================
// Flat Thumbnail Migration (eski düz yapı → sub-directory hashing)
// =========================================================================

/**
 * Eski düz yapıdaki (/data/thumbs/<id>.jpg) thumbnail'ları yeni sub-directory
 * yapısına (/data/thumbs/a1/b2/<id>.jpg) taşır. Bir kez çalışır (flatThumbMigrationDone).
 *
 * Bu migration yalnızca local thumbnail cache'i içindir — ana dosya storage'ı
 * (bucket) bundan bağımsızdır. Thumbnail'lar her zaman local diskte saklanır.
 *
 * Migration stratejisi:
 *   - /data/thumbs/ kökünde doğrudan .jpg / .fail dosyaları varsa eski düz yapının
 *     kalıntısıdır (sub-dir yapısında tüm dosyalar a1/b2/ altındadır).
 *   - Her flat dosyayı yeni getThumbPath/getThumbFailMarkerPath yoluna taşı.
 *   - Hedef zaten varsa (on-demand regen üretmiş olabilir) flat dosyayı sil.
 *
 * Bu migration zararsızdır: yeni sub-dir'de zaten thumbnail varsa flat dosya
 * sadece silinir; yoksa taşınır. Veri kaybı olmaz.
 */
async function migrateFlatThumbs() {
  if (flatThumbMigrationDone) return;
  flatThumbMigrationDone = true;

  if (!fs.existsSync(THUMBS_DIR)) return;

  let moved = 0;
  let removed = 0;

  try {
    const entries = fs.readdirSync(THUMBS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      // Sadece düz dosyaları işle (dizinler = yeni sub-dir yapısı, atla)
      if (!entry.isFile()) continue;

      const flatPath = path.join(THUMBS_DIR, entry.name);
      // Dosya adından fileId çıkar: "<id>.jpg" veya "<id>.fail"
      const match = entry.name.match(/^(.+)\.(jpg|fail)$/);
      if (!match) continue;
      const fileId = match[1];
      const ext = match[2];

      const targetPath = ext === 'jpg'
        ? getThumbPath(fileId)
        : getThumbFailMarkerPath(fileId);

      try {
        // Hedef alt dizini oluştur
        await ensureThumbSubDir(fileId);

        if (fs.existsSync(targetPath)) {
          // Hedef zaten var (on-demand üretildi) → flat dosyayı sil
          fs.unlinkSync(flatPath);
          removed++;
        } else {
          // Taşı
          fs.renameSync(flatPath, targetPath);
          moved++;
        }
      } catch (err) {
        console.error(`[Cleanup] Flat thumb migration failed for ${entry.name}:`, err.message);
      }
    }

    if (moved > 0 || removed > 0) {
      console.log(`[Cleanup] Flat thumb migration: ${moved} moved, ${removed} removed (dedup).`);
    }
  } catch (err) {
    console.error('[Cleanup] Flat thumb migration error:', err.message);
    // Hata durumunda flag'i reset et ki bir sonraki cycle'da tekrar deneyebilsin
    flatThumbMigrationDone = false;
  }
}

// =========================================================================
// Periyodik Çalıştırma
// =========================================================================

/**
 * Cleanup job'unu başlatır.
 * Config'den `cleanup_interval_minutes` değerini okur.
 */
async function startCleanupJob() {
  // Config'den interval değerini oku
  try {
    const intervalStr = await getConfig('cleanup_interval_minutes');
    if (intervalStr) {
      const minutes = parseInt(intervalStr);
      if (minutes > 0) {
        cleanupIntervalMs = minutes * 60 * 1000;
      }
    }
  } catch (err) {
    console.log('[Cleanup] Using default interval (15 minutes).');
  }

  console.log(`[Cleanup] Starting cleanup job. Interval: ${cleanupIntervalMs / 60000} minutes.`);

  // İlk temizliği hemen yap (başlangıçta birikmiş olabilir)
  // Önce eski düz yapılı thumbnail'ları migrate et (sub-directory hashing).
  await migrateFlatThumbs();
  await runCleanup();

  // Periyodik çalıştır
  intervalHandle = setInterval(runCleanup, cleanupIntervalMs);

  // Interval'in event loop'u bloke etmesini engelle
  intervalHandle.unref();
}

/**
 * Cleanup job'unu durdurur.
 */
function stopCleanupJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Cleanup] Cleanup job stopped.');
  }
}

// =========================================================================
// Yardımcılar
// =========================================================================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// =========================================================================
// Export
// =========================================================================

module.exports = {
  runCleanup,
  cleanupExpiredBundles,
  startCleanupJob,
  stopCleanupJob,
  migrateFlatThumbs,
};
