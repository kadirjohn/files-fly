/**
 * cleanup-job.js — Süresi Dolan Dosyaları Temizleme Cron Job'u
 * 
 * setInterval ile periyodik olarak çalışır.
 * Config'deki `cleanup_interval_minutes` değerine göre sıklık ayarlanır.
 * 
 * İşlem:
 * 1. expire_at < NOW() olan dosyaları PG'den sorgula
 * 2. Her dosyayı diskten sil (fs.unlink)
 * 3. PG'den kaydı sil
 * 4. İstatistik logla
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./database');
const { getConfig } = require('./config-service');
const { deleteThumb } = require('./storage-service');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

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
    // 1. Süresi dolmuş dosyaları PG'den sorgula
    // -----------------------------------------------------------------------
    const result = await query(
      `SELECT id, storage_path, file_size, filename
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
    // 2. Her dosyayı diskten sil ve PG'den kaldır
    // -----------------------------------------------------------------------
    for (const file of expiredFiles) {
      try {
        // Diskten sil
        if (file.storage_path && fs.existsSync(file.storage_path)) {
          await fs.promises.unlink(file.storage_path);
          freedBytes += parseInt(file.file_size) || 0;
        }

        // Thumbnail cache'ini de temizle (image dosyaları için)
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

        // Dosya diskte yoksa PG'den yine de sil (orphan kayıt)
        if (err.code === 'ENOENT') {
          try {
            await query(`DELETE FROM files WHERE id = $1`, [file.id]);
            deletedCount++;
          } catch (dbErr) {
            console.error(`[Cleanup] Error removing orphan record ${file.id}:`, dbErr.message);
          }
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
// Orphan Chunk Dizin Temizliği
// =========================================================================

/**
 * /data/uploads/tmp/ altında kalmış, artık PG'de kaydı olmayan
 * chunk dizinlerini temizler.
 */
async function cleanupOrphanChunkDirs() {
  const tmpDir = path.join(UPLOADS_DIR, 'tmp');

  if (!fs.existsSync(tmpDir)) return;

  try {
    const dirs = fs.readdirSync(tmpDir);

    for (const dir of dirs) {
      const dirPath = path.join(tmpDir, dir);
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
  startCleanupJob,
  stopCleanupJob,
};
