-- =========================================================================
-- Migration 003: Audit Log Table + Encrypt Existing Plaintext Secrets
-- =========================================================================
-- İki iş yapar (idempotent):
--
-- 1. audit_log tablosu oluştur — admin işlemlerini (credential değişikliği,
--    storage backend switch, ban/unban, dosya silme) who/when/what biçiminde
--    kaydeder. metadata JSONB — structured veri (hangi key'ler güncellendi).
--    Hassas DEĞERLER asla metadata'ya yazılmaz (sadece key adları).
--
-- 2. Mevcut plaintext secret'leri şifrele — migration 002'de admin panelden
--    girilmiş olabilir (plaintext). crypto-vault.js "enc:v1:" prefix'i ile
--    şifreli/plaintext ayrımı yapar; bu migration sadece plaintext olanları
--    şifreler. Şifreleme Node.js tarafında yapıldığı için bu kısım sadece
--    tabloyu hazırlar — gerçek şifreleme server.js startup'ta migrate-secrets
--    adımıyla yapılır (bkz. services/storage/index.js migratePlaintextSecrets).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. audit_log tablosu
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    admin_user      VARCHAR(64) NOT NULL,
    action          VARCHAR(128) NOT NULL,
    target          VARCHAR(255),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin_user ON audit_log(admin_user);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log(action);

-- -------------------------------------------------------------------------
-- 2. Plaintext secret şifreleme için flag (server.js startup'ta işlenir)
-- -------------------------------------------------------------------------
-- crypto-vault.js Node.js tarafında AES-256-GCM şifreleme yapar — SQL
-- bunu yapamaz. Bu yüzden migration sadece bir config flag set eder;
-- server.js başlangıcında migratePlaintextSecrets() bu flag'i görür,
-- plaintext secret'leri şifreler, sonra flag'i temizler.
--
-- Flag: 'storage:secrets_migration_pending' = '1'
-- (idempotent — flag yoksa migrate edilmiş demektir)

INSERT INTO config (key, value) VALUES
    ('storage:secrets_migration_pending', '1')
ON CONFLICT (key) DO NOTHING;
