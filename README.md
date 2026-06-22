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
# .env'i aç ve şu SİSTEM-SEVİYE değerleri üret/doldur:
#   JWT_SECRET             — openssl rand -base64 64
#   IP_HASH_SECRET         — openssl rand -base64 64
#   CREDENTIALS_MASTER_KEY — openssl rand -base64 32   (storage şifreleme anahtarı)
#   ADMIN_PASSWORD         — kendi şifren
```

> **R2 / Supabase credential'larını `.env`'e YAZMA.** Bu dosyada yalnızca
> sistem-seviye sırlar (JWT, IP hash, Master Key) bulunur. Cloudflare R2 ve
> Supabase Storage bağlantı bilgilerini **uygulama çalıştıktan sonra admin
> panelden** girersin — orada AES-256-GCM ile şifrelenip veritabanına yazılır ve
> restart gerektirmeden anında etkin olur. (Bkz. aşağıdaki "Storage Backend
> Seçimi".)

### 2. Konteynerleri başlat

```bash
docker compose up -d --build
```

Bu komut:
- PostgreSQL + Node.js konteynerlerini başlatır
- 3 migration'ı otomatik çalıştırır (schema + object-storage + audit-log)
- Storage backend'ini başlatır (varsayılan: `local`)
- Docker imajı AWS SDK'yı (R2/Supabase için) kutudan çıktığı gibi içerir — ekstra `npm install` gerekmez

### 3. Admin kullanıcısı oluştur (ÖNEMLİ)

`docker compose up -d` DB'yi boş başlatır. Admin paneline girmek için admin kullanıcısı oluşturman gerekir:

```bash
docker compose exec filesfly node seed.js admin admin123
```

> ⚠️ **Bu adımı atlama!** Aksi halde `/admin` paneline giriş yapamazsın ("invalid credentials" hatası alırsın). DB'yi `docker compose down -v` ile sıfırlarsan bu adımı tekrarlaman gerekir.

### 4. Erişim

- Ana sayfa: `http://localhost:9392`
- Admin panel: `http://localhost:9392/admin` → `admin` / `admin123`

### 5. (Opsiyonel) Cloud storage'a geç

Yerel disk (varsayılan) yerine Cloudflare R2 veya Supabase Storage kullanmak istersen — **`.env`'i tekrar düzenlemeden**, admin panelden yap:

1. Admin → **Ayarlar** → **Storage** sekmesi
2. R2 veya Supabase **kartına tıkla** → credential modal'ı açılır
3. Account ID / Access Key / Secret / Bucket gir → **Kaydet**
4. **"Depolama Backend'ini Uygula"** → yeni dosyalar artık bucket'a

Detaylı akış aşağıda.

## Storage Backend Seçimi (Admin Panel)

Admin → **Ayarlar** → **Storage** bölümü:

1. **Yerel Disk** (varsayılan) — sıfır yapılandırma, dosyalar `/data/uploads`'a
2. **Cloudflare R2** — S3-uyumlu, çıkış trafiği ücretsiz
3. **Supabase Storage** — S3-uyumlu endpoint

### R2/Supabase'ı aktifleştirme akışı (admin panel — restart yok)

1. Admin panelde **Ayarlar → Storage**'a git, R2 veya Supabase **kartına tıkla**
2. Açılan credential modalında Account ID / Access Key / Secret / Bucket gir → **Kaydet**
3. Secret Key **AES-256-GCM ile şifrelenip DB'ye yazılır** (plaintext değil) — anında
4. Kart "Yapılandırılmadı" → "Hazır" rozetine döner
5. Backend'i seçip **"Depolama Backend'ini Uygula"** butonuna tıkla → R2/Supabase aktif
6. Yeni dosyalar artık bucket'e yüklenir; mevcut dosyalar kendi backend'inde kalır (orphan blob olmaz)

> **Tüm bu adımlar runtime'da olur — sunucuyu restart etmen gerekmez.** Provider
> cache'i credential değişince invalidate edilir; backend switch `setActiveBackend`
> ile anında etkinleşir.

### Credential güvenliği (endüstri standardı)

- **Encryption at rest:** Secret key'ler DB'de `enc:v1:` prefix'li AES-256-GCM ciphertext olarak saklanır. DB sızdırılsa bile anahtarlar okunamaz.
- **Şifreleme anahtarı:** `.env`'deki tek sistem-seviye sır `CREDENTIALS_MASTER_KEY` — PBKDF2 ile 32-byte AES key türetilir. R2/Supabase credential'larının kendisi `.env`'de DEĞİL, DB'de (şifreli) durur.
- **UI maskeleme:** Admin panelde secret "● Ayarlandı" rozeti olarak gösterilir — raw değer asla frontend'e gönderilmez.
- **RBAC + audit log:** Ayarlar sayfası admin auth arkasında; "Son Değişiklikler" bölümünde kim/ne zaman/hangi key'ler değişti kayıtlı.
- **Restart gerektirmeyen esneklik:** Credential güncelleme + backend switch ikisi de runtime — `.env` veya sunucu restart'ı gerekmez.
- ⚠️ `CREDENTIALS_MASTER_KEY`'i değiştirirsen DB'deki şifreli secret'lar decrypt edilemez (yeniden girilmesi gerekir). Üretimde bir kez set et, sonra dokunma.

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
| `CREDENTIALS_MASTER_KEY` | Storage credential şifreleme Master Key (boş = plaintext) | (değiştir!) |
| `STORAGE_BACKEND` | İlk açılışta varsayılan backend | `local` |
| `UPLOADS_DIR` | Local backend dosya dizini | `/data/uploads` |

> **R2 / Supabase credential'ları (Account ID, Access Key, Secret, Bucket) `.env`'de
> YOK** — bunlar admin panelden girilir ve DB'de AES-256-GCM ile şifreli saklanır.
> `STORAGE_BACKEND` ise ilk açılıştan sonra admin panelden değiştirilir (runtime,
> restart yok); `.env`'deki değer sadece ilk boot'taki varsayılanı belirler.

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
