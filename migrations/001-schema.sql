-- =========================================================================
-- Migration 001: Initial Schema
-- =========================================================================

-- UUID oluşturma eklentisi
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -------------------------------------------------------------------------
-- 1. Admin kullanıcıları (bağımlılık yok, önce oluştur)
-- -------------------------------------------------------------------------
CREATE TABLE admin_users (
    username        VARCHAR(64) PRIMARY KEY,
    password_hash   TEXT NOT NULL,                   -- crypto.scrypt hash (salt:hash formatı)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 2. Kullanıcı oturumları (files ve banned_ips buna bağımlı)
-- -------------------------------------------------------------------------
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ip_hash         VARCHAR(64) NOT NULL,            -- SHA-256 HMAC hash'lenmiş IP (privacy)
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX idx_sessions_ip_hash   ON sessions(ip_hash);

-- -------------------------------------------------------------------------
-- 3. Dosya metadata tablosu (sessions'a FK)
-- -------------------------------------------------------------------------
CREATE TABLE files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ip_hash         VARCHAR(64) NOT NULL,            -- SHA-256 HMAC hash'lenmiş IP (privacy)
    filename        VARCHAR(512) NOT NULL,           -- Orijinal dosya adı
    file_size       BIGINT NOT NULL,                 -- Byte cinsinden
    mime_type       VARCHAR(128),                    -- MIME type (video/mp4, image/png...)
    storage_path    TEXT NOT NULL,                   -- Yerel: /data/uploads/abc123.mp4
    direct_url      TEXT NOT NULL,                   -- İndirme linki
    expire_at       TIMESTAMPTZ NOT NULL,            -- Silinme zamanı (UTC)
    is_encrypted    BOOLEAN DEFAULT FALSE,            -- Parola korumalı mı?
    encryption_iv   TEXT,                             -- AES-GCM IV (base64, sadece encrypted=true ise)
    encryption_salt TEXT,                             -- PBKDF2 salt (base64, sadece encrypted=true ise)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    download_count  INTEGER DEFAULT 0
);

-- İndeksler
CREATE INDEX idx_files_session_id  ON files(session_id);
CREATE INDEX idx_files_ip_hash     ON files(ip_hash);
CREATE INDEX idx_files_expire_at   ON files(expire_at);
CREATE INDEX idx_files_created_at  ON files(created_at);
CREATE INDEX idx_files_mime_type   ON files(mime_type);

-- -------------------------------------------------------------------------
-- 4. IP yasaklama listesi (admin_users'a FK)
-- -------------------------------------------------------------------------
CREATE TABLE banned_ips (
    ip_hash         VARCHAR(64) PRIMARY KEY,          -- SHA-256 HMAC hash'lenmiş IP
    reason          TEXT,
    banned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    banned_by       VARCHAR(64) REFERENCES admin_users(username),
    expires_at      TIMESTAMPTZ                      -- NULL = kalıcı ban, doluysa TTL
);

CREATE INDEX idx_banned_ips_expires ON banned_ips(expires_at);

-- -------------------------------------------------------------------------
-- 5. Sistem yapılandırması
-- -------------------------------------------------------------------------
CREATE TABLE config (
    key             VARCHAR(64) PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- Varsayılan config değerleri (seed)
-- -------------------------------------------------------------------------
INSERT INTO config (key, value) VALUES
    ('max_file_size_mb', '100'),
    ('rate_limit_requests', '10'),
    ('rate_limit_window_minutes', '60'),
    ('default_expire_hours', '1'),
    ('max_expire_hours', '48'),
    ('allowed_mime_types', '*'),            -- '*' = hepsi, veya 'image/*,video/*,text/*'
    ('chunk_size_mb', '5'),                -- Chunked upload parça boyutu
    ('cleanup_interval_minutes', '15');    -- Süresi dolan dosya temizleme sıklığı
