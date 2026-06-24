/**
 * scripts/backfill-mime.js — Eski dosyaların mime_type'ını geriye dönük düzeltir.
 *
 * Neden: commit 382b02e'den ÖNCE yüklenen dosyaların mime_type değeri
 * bozuk/boş bırakılmış olabilir (ya 'application/octet-stream' ya NULL).
 * Bu dosyaların /b/:id receiver önizlemesi ve admin "Tür" kolonu yanlış
 * görünür. Bu script dosya ADINDAN (uzantı) gerçek MIME'i çıkarsar ve
 * UPDATE eder. Yeni yüklemeler zaten upload-service.getMimeType ile doğru
 * mime alıyor (382b02e fix); bu sadece geçmiş veriyi düzeltir.
 *
 * Kullanım (server'ın kullandığı aynı .env/DATABASE_URL ile):
 *   node scripts/backfill-mime.js
 *   node scripts/backfill-mime.js --dry-run   # sadece rapor, UPDATE yapmaz
 *
 * Güvenli: idempotent, salt-okunur koşulda (dry-run) hiçbir şey yazmaz.
 * Kullanıcı çalıştırır (Claude commit/çalıştırma kuralı — bkz. memory
 * user-commits-not-claude). Server'ın migration'ları zaten çalışmış olmalı.
 */

const { query } = require('../services/database');
const { getMimeType } = require('../services/upload-service');

// Bozuk kabul edilen değerler: NULL, boş string, ya da "bilinmiyor" sentinel'i.
// Gerçek bir image/video/pdf bu değerlerde olamaz → uzantıdan yeniden çıkarsa.
function isBadMime(m) {
  if (m === null || m === undefined) return true;
  const s = String(m).trim();
  if (s === '' || s === 'application/octet-stream') return true;
  return false;
}

async function backfill({ dryRun = false } = {}) {
  console.log(dryRun ? '[Backfill] DRY-RUN modu — UPDATE yok.' : '[Backfill] Başlıyor...');

  // Önce DB bağlantısı.
  try {
    await query('SELECT 1 AS ok');
    console.log('[Backfill] Database connection OK.');
  } catch (err) {
    console.error('[Backfill] DB bağlantısı başarısız:', err.message);
    console.error('[Backfill] Server en az bir kez başlamış ve migrationlar çalışmış olmalı.');
    process.exit(1);
  }

  // Tüm dosyaları al (mime_type + filename). Bundle farketmeksizin tüm files.
  const { rows } = await query(
    'SELECT id, filename, mime_type FROM files ORDER BY created_at DESC'
  );
  console.log(`[Backfill] Toplam ${rows.length} dosya bulundu.`);

  const candidates = rows.filter((r) => isBadMime(r.mime_type));
  console.log(`[Backfill] Bozuk/boş mime_type'lı: ${candidates.length} dosya.`);

  if (candidates.length === 0) {
    console.log('[Backfill] Düzeltilecek dosya yok. ✓');
    return;
  }

  let updated = 0;
  let skipped = 0;
  const byMime = {};

  for (const r of candidates) {
    const derived = getMimeType(r.filename);
    // getMimeType bilinmeyen uzantı için 'application/octet-stream' döner —
    // bu durumda düzeltme anlamsız (zaten o değer); atla.
    if (derived === 'application/octet-stream') {
      skipped++;
      continue;
    }
    byMime[derived] = (byMime[derived] || 0) + 1;

    if (!dryRun) {
      await query('UPDATE files SET mime_type = $2 WHERE id = $1', [r.id, derived]);
    }
    updated++;
  }

  console.log(`[Backfill] ${dryRun ? 'Düzeltilecek' : 'Düzeltildi'}: ${updated} dosya.`);
  if (skipped > 0) console.log(`[Backfill] Atlandı (uzantıdan tür çıkarılamadı): ${skipped} dosya.`);
  console.log('[Backfill] Tür dağılımı:', JSON.stringify(byMime));
  console.log(dryRun ? '[Backfill] DRY-RUN tamamlandı — değişiklik yok.' : '[Backfill] Tamamlandı. ✓');
}

// CLI: --dry-run flag'ını işle.
const dryRun = process.argv.includes('--dry-run');
backfill({ dryRun })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Backfill] Hata:', err);
    process.exit(1);
  });
