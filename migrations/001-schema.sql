-- =========================================================================
-- Migration 001: Initial Schema (Idempotent)
-- =========================================================================

-- UUID oluşturma eklentisi
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -------------------------------------------------------------------------
-- 1. Admin kullanıcıları
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
    username        VARCHAR(64) PRIMARY KEY,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 2. Kullanıcı oturumları
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ip_hash         VARCHAR(64) NOT NULL,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_ip_hash   ON sessions(ip_hash);

-- -------------------------------------------------------------------------
-- 3. Dosya metadata tablosu
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ip_hash         VARCHAR(64) NOT NULL,
    filename        VARCHAR(512) NOT NULL,
    file_size       BIGINT NOT NULL,
    mime_type       VARCHAR(128),
    storage_path    TEXT NOT NULL,
    direct_url      TEXT NOT NULL,
    expire_at       TIMESTAMPTZ NOT NULL,
    is_encrypted    BOOLEAN DEFAULT FALSE,
    encryption_iv   TEXT,
    encryption_salt TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    download_count  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_session_id  ON files(session_id);
CREATE INDEX IF NOT EXISTS idx_files_ip_hash     ON files(ip_hash);
CREATE INDEX IF NOT EXISTS idx_files_expire_at   ON files(expire_at);
CREATE INDEX IF NOT EXISTS idx_files_created_at  ON files(created_at);
CREATE INDEX IF NOT EXISTS idx_files_mime_type   ON files(mime_type);

-- -------------------------------------------------------------------------
-- 4. IP yasaklama listesi
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banned_ips (
    ip_hash         VARCHAR(64) PRIMARY KEY,
    reason          TEXT,
    banned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    banned_by       VARCHAR(64) REFERENCES admin_users(username),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_banned_ips_expires ON banned_ips(expires_at);

-- -------------------------------------------------------------------------
-- 5. Sistem yapılandırması
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
    key             VARCHAR(64) PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- Varsayılan config değerleri (seed — sadece yoksa ekle)
-- -------------------------------------------------------------------------
INSERT INTO config (key, value) VALUES
    ('max_file_size_mb', '100'),
    ('rate_limit_requests', '10'),
    ('rate_limit_window_minutes', '60'),
    ('default_expire_hours', '1'),
    ('max_expire_hours', '48'),
    ('allowed_mime_types', '*'),
    ('chunk_size_mb', '5'),
    ('cleanup_interval_minutes', '15')
ON CONFLICT (key) DO NOTHING;
