# Files Fly

Geçici dosya paylaşım platformu — **Object Storage (Bucket)** mimarisi, chunked upload, AES-256-GCM şifreli credential yönetimi, admin panel ve IP yönetimi.

Dosyalar veritabanında saklanmaz. DB sadece metadata (object key + backend) tutar; dosyanın kendisi pluggable bir Object Storage backend'inde (yerel disk / Cloudflare R2 / Supabase Storage) durur. Bu, sektör standardı "Bucket" mantığıdır.

## Özellikler

- **Object Storage / Bucket abstraction** — local disk, Cloudflare R2, Supabase Storage (S3-uyumlu)
- **DB-backed + şifreli credential yönetimi** — R2/Supabase key'leri admin panelden girilir, AES-256-GCM ile DB'ye şifrelenir (`.env`'de tek Master Key)
- **Chunked upload** — büyük dosyalar parça parça, resume destekli
- **AES-GCM parola koruması** — client-side şifreleme, server plaintext görmez
- **Admin panel** — dosya listesi, önizleme (text/image/video/PDF), IP yasaklama, ayarlar, audit log
- **Süresi dolan dosyaları otomatik temizleme** — cron job, her dosya kendi backend'inden silinir
- **Cloud indirme** — R2/Supabase'de presigned URL + 302 redirect (sunucu trafiği yok)
- **Range destekli streaming** — video resume, partial download (local backend)

## Hızlı Başlangıç (Docker)

### 1. `.env` oluştur

```bash
cp .env.example .env
# .env'i aç ve şu değerleri değiştir:
#   JWT_SECRET         — openssl rand -base64 64
#   IP_HASH_SECRET     — openssl rand -base64 64
#   CREDENTIALS_MASTER_KEY — openssl rand -base64 32 (şifreli credential için)
#   ADMIN_PASSWORD     — kendi şifren
```

### 2. Konteynerleri başlat

```bash
docker compose up -d --build
```

Bu komut:
- PostgreSQL + Node.js konteynerlerini başlatır
- 3 migration'ı otomatik çalıştırır (schema + object-storage + audit-log)
- Storage backend'ini başlatır (varsayılan: `local`)

### 3. Admin kullanıcısı oluştur (ÖNEMLİ)

`docker compose up -d` DB'yi boş başlatır. Admin paneline girmek için admin kullanıcısı oluşturman gerekir:

```bash
docker compose exec filesfly node seed.js admin admin123
```

> ⚠️ **Bu adımı atlama!** Aksi halde `/admin` paneline giriş yapamazsın ("invalid credentials" hatası alırsın). DB'yi `docker compose down -v` ile sıfırlarsan bu adımı tekrarlaman gerekir.

### 4. Erişim

- Ana sayfa: `http://localhost:9392`
- Admin panel: `http://localhost:9392/admin` → `admin` / `admin123`

## Storage Backend Seçimi (Admin Panel)

Admin → **Ayarlar** → **Dosya Depolama** bölümü:

1. **Yerel Disk** (varsayılan) — sıfır yapılandırma, dosyalar `/data/uploads`'a
2. **Cloudflare R2** — S3-uyumlu, çıkış trafiği ücretsiz
3. **Supabase Storage** — S3-uyumlu endpoint

### R2/Supabase'ı aktifleştirme akışı

1. Admin panelde R2/Supabase altında **"Credential'ları Düzenle"** butonuna tıkla
2. Account ID, Access Key, Secret Key, Bucket Name gir → **Kaydet**
3. Secret Key **AES-256-GCM ile şifrelenip DB'ye yazılır** (plaintext değil)
4. Backend "Credential Eksik" → "Hazır" rozetine döner
5. **"Depolama Backend'ini Uygula"** butonuna tıkla → R2/Supabase aktif
6. Yeni dosyalar artık bucket'e yüklenir; mevcut dosyalar kendi backend'inde kalır

### Credential güvenliği

- Secret key'ler DB'de `enc:v1:` prefix'li AES-256-GCM ciphertext olarak saklanır
- `.env`'deki `CREDENTIALS_MASTER_KEY` ile şifrelenir (PBKDF2 → 32-byte key)
- Admin panelde secret "Ayarlandı" rozeti olarak gösterilir (asla raw değer)
- "Son Değişiklikler" bölümünde audit log (kim/ne zaman/hangi key'ler)
- Master Key'i değiştirirsen DB'deki şifreli secret'lar decrypt edilemez (yeniden girilir)

## Sık Kullanılan Komutlar

```bash
# Restart (kod/env değiştiğinde)
docker compose down && docker compose up -d

# Tam sıfırlama (DB + dosyalar silinir!)
docker compose down -v && docker compose up -d --build

# Admin user yeniden oluştur (DB sıfırlanınca)
docker compose exec filesfly node seed.js admin admin123

# Logları izle
docker compose logs -f filesfly

# Migration'ları manuel çalıştır
docker compose exec filesfly node services/database.js --migrate

# DB'ye bağlan
docker compose exec postgres psql -U filesfly -d filesfly

# Şifreli credential'ları DB'de kontrol et
docker compose exec postgres psql -U filesfly -d filesfly \
  -c "SELECT key, substring(value,1,20) FROM config WHERE key LIKE 'storage:%';"
```

## Yapılandırma

Tüm ayarlar `.env` veya admin panel üzerinden. Detaylı açıklama için [`.env.example`](.env.example).

| Değişken | Açıklama | Varsayılan |
|----------|----------|------------|
| `DATABASE_URL` | PostgreSQL bağlantı URL | `postgresql://filesfly:...@localhost:5432/filesfly` |
| `JWT_SECRET` | Admin login JWT imzalama key | (değiştir!) |
| `IP_HASH_SECRET` | IP hash'leme key (boşsa restart'ta değişir) | (değiştir!) |
| `CREDENTIALS_MASTER_KEY` | Credential şifreleme Master Key (boş = plaintext) | (değiştir!) |
| `STORAGE_BACKEND` | Aktif backend: `local` / `r2` / `supabase` | `local` |
| `UPLOADS_DIR` | Local backend dosya dizini | `/data/uploads` |
| `R2_*` / `SUPABASE_*` | Cloud backend credential'ları | (admin panelden de girilebilir) |

## Mimari

```
İstemci → [HTTPS] → server.js (Node.js, zero-dep HTTP)
                      ↓
                   Storage Provider (local / R2 / Supabase)
                      ↓
                   Object Storage (disk / bucket)
                      ↓
                   DB (PostgreSQL) — sadece metadata + şifreli credential
```

- `services/storage/` — provider abstraction (local, s3-base, r2, supabase, factory)
- `services/crypto-vault.js` — AES-256-GCM credential şifreleme
- `services/audit-service.js` — admin işlem denetim günlüğü
- `services/upload-service.js` / `chunk-upload.js` — dosya yükleme
- `services/download-service.js` — indirme (local: stream, cloud: 302 redirect)
- `services/cleanup-job.js` — süresi dolan dosyaları temizleme
- `routes/` — HTTP route'ları (files, upload, admin, session)
- `migrations/` — PostgreSQL schema migration'ları

## License

Private.
