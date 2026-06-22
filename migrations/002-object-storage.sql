-- =========================================================================
-- Migration 002: Object Storage / Bucket Abstraction
-- =========================================================================
-- Amaç: Dosya içeriklerini "Object Storage / Bucket" modeline taşımak.
-- Eskiden `files.storage_path` mutlak disk yolu (abs path) içeriyordu.
-- Artık dosyanın nerede saklandığını iki ayrı alan tutar:
--   storage_backend : 'local' | 'r2' | 'supabase' (hangi provider)
--   storage_key     : object key (örn: "abc-123.mp4") — backend-bağımsız
--
-- Bu sayede:
--   - DB sadece metin (URL/key) saklar → yedeklemesi saniyeler sürer
--   - Dosyanın kendisi cloud bucket'inde (S3/R2/Supabase) veya diskte
--   - Backend değiştirilse bile her dosya kendi backend'ini hatırlar
--     (cleanup/delete orphan blob bırakmadan doğru yeri temizler)
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Yeni sütunları ekle (idempotent)
-- -------------------------------------------------------------------------
-- storage_backend: NULL = eski kayıt (migration backfill 'local' yazar)
-- storage_key    : NULL = eski kayıt (backfill storage_path'ten basename alır)

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32);
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS storage_key TEXT;

-- -------------------------------------------------------------------------
-- 2. Backfill: storage_path'ten storage_key + storage_backend türet
-- -------------------------------------------------------------------------
-- Eski kayıtlar local diskte (/data/uploads/<file>) saklanıyordu.
-- storage_key = dosya adı (basename), storage_backend = 'local'.
-- Bu blok yalnızca storage_key NULL olan satırları günceller (idempotent).

UPDATE files
SET storage_backend = 'local',
    storage_key     = regexp_replace(storage_path, '^.*[/\\]', '')
WHERE storage_key IS NULL
  AND storage_path IS NOT NULL;

-- Hâlâ NULL kalan (storage_path yok ama somehow eklenmiş) kayıtlar için
-- güvenli fallback: 'local' backend + NULL key (silinirken atlanır).
UPDATE files
SET storage_backend = 'local'
WHERE storage_backend IS NULL;

-- -------------------------------------------------------------------------
-- 3. Default değer + NOT NULL kısıtı (backfill sonrası)
-- -------------------------------------------------------------------------
-- Artık tüm satırlarda storage_backend dolu. Yeni eklemeler default 'local'.

ALTER TABLE files
    ALTER COLUMN storage_backend SET DEFAULT 'local';

ALTER TABLE files
    ALTER COLUMN storage_backend SET NOT NULL;

-- storage_key opsiyonel kalabilir (orphan/manuel silme senaryoları için),
-- ama aktif dosyalar için NOT NULL mantıklı. Mevcut veriyi bozmamak adına
-- sadece NOT NULL ekle (backfill zaten doldurdu; kalan NULL yoksa başarılı).
-- Eğer hâlâ NULL satır varsa migration hata verir → manuel müdahale gerekir.
-- Güvenli yol: önce NULL kalmadığından emin ol, sonra NOT NULL koy.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM files WHERE storage_key IS NULL AND storage_path IS NULL) THEN
        RAISE NOTICE 'Bazı satırlarda storage_key ve storage_path birlikte NULL — NOT NULL kısıtı atlandı.';
    ELSE
        ALTER TABLE files ALTER COLUMN storage_key SET NOT NULL;
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- 4. Eski storage_path sütununu kaldır
-- -------------------------------------------------------------------------
-- Backfill tamamlandı, artık storage_path'e ihtiyaç yok.
-- (NOT: 001-schema.sql IF NOT EXISTS kullandığı için, bu sütunu silen
--  bu migration tek başına yeterli — yeniden çalışsa storage_path yoktur,
--  DROP COLUMN IF EXISTS zararsızdır.)

ALTER TABLE files
    DROP COLUMN IF EXISTS storage_path;

-- -------------------------------------------------------------------------
-- 5. Index'ler (cleanup hızlandırma — backend'e göre silme)
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_files_storage_backend ON files(storage_backend);

-- -------------------------------------------------------------------------
-- 6. Config: aktif storage backend'i
-- -------------------------------------------------------------------------
-- Admin panel "storage_backend" key'ini güncelleyerek yeni dosyaların
-- hangi bucket'a yazılacağını seçer. Varsayılan: 'local'.
INSERT INTO config (key, value) VALUES
    ('storage_backend', 'local')
ON CONFLICT (key) DO NOTHING;
