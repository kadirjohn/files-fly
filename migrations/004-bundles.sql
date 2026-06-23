-- migrations/004-bundles.sql
-- =========================================================================
-- Migration 004: Bundles (multi-file sharing, one link per upload batch)
-- =========================================================================
-- Amaç: Tek yükleme eyleminde birden fazla dosyayı tek bir "bundle" altında
-- toplamak ve tek bir paylaşım linki (/b/:bundleId) vermek. Geri uyumlu:
-- bundle_id nullable → eski dosyalar bundlesuz çalışır; backfill her mevcut
-- dosyayı 1:1 bundle'a sarar → eski /files/:id linkleri /b/:bundleId'ye yönlendirir.

CREATE TABLE IF NOT EXISTS bundles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title           VARCHAR(255),
    file_count      INTEGER NOT NULL DEFAULT 0,
    total_size      BIGINT NOT NULL DEFAULT 0,
    expire_at       TIMESTAMPTZ NOT NULL,
    is_encrypted    BOOLEAN DEFAULT FALSE,
    password_salt   TEXT,                  -- bundle-level shared salt (NULL = legacy per-file salt)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bundles_session_id  ON bundles(session_id);
CREATE INDEX IF NOT EXISTS idx_bundles_expire_at   ON bundles(expire_at);
CREATE INDEX IF NOT EXISTS idx_bundles_created_at  ON bundles(created_at);

-- files.bundle_id: nullable FK. ON DELETE CASCADE → bundle silinince dosyalar da silinir.
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS bundle_id UUID REFERENCES bundles(id) ON DELETE CASCADE;
ALTER TABLE files ALTER COLUMN bundle_id SET DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_files_bundle_id ON files(bundle_id);

-- -------------------------------------------------------------------------
-- Backfill: her bundlesuz dosyayı 1:1 bundle'a sar.
-- bundle.id = file.id (ÖNEMLİ: bundle paylaşım linki /b/:bundleId, eski /files/:id
--   linkiyle AYNI UUID'ye işaret etsin → /files/:id → /b/:bundleId redirect birebir).
-- password_salt NULL bırakılır → backfill'li dosyalar per-file salt kullanmaya devam eder.
-- -------------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, session_id, file_size, expire_at, is_encrypted, created_at
           FROM files WHERE bundle_id IS NULL
  LOOP
    INSERT INTO bundles (id, session_id, file_count, total_size, expire_at, is_encrypted, created_at)
    VALUES (r.id, r.session_id, 1, r.file_size, r.expire_at, r.is_encrypted, r.created_at)
    ON CONFLICT (id) DO NOTHING;
    UPDATE files SET bundle_id = r.id WHERE id = r.id AND bundle_id IS NULL;
  END LOOP;
END $$;
