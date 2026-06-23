/**
 * app.js — Files Fly Ana Sayfa JavaScript
 *
 * Özellikler:
 * - Çoklu dosya seçimi (drag & drop + file input multiple)
 * - BatchUpload: tek bir bundle linki için paralel çoklu dosya yükleme
 * - Tray UI: sağ-alt köşede her batch için kart (progress + durum + aksiyon)
 * - localStorage ile batch kalıcılığı (reload sonrası link kopyalama)
 * - Parola koruma (AES-GCM — Faz 4.3, bundle ortak salt)
 * - Tek seferde upload (küçük) + Chunked upload (büyük, resume destekli)
 * - Başarılı: link kopyalama, QR kod, canlı countdown
 * - Toast notification
 *
 * Refactor (Task 13): tek-dosya global state → per-batch BatchUpload instance.
 * Eski global selectedFile/xhr/abortController/fileId/chunkedMode kaldırıldı;
 * her batch kendi activeXhrs map'ini tutar. Eski #file-preview tek-dosya
 * preview elementi HTML'den kaldırıldı (#file-queue listesi geldi).
 */

// =========================================================================
// DOM Referansları
// =========================================================================

const DOM = {
  // Steps
  stepSelect: document.getElementById('step-select'),
  stepUploading: document.getElementById('step-uploading'),
  stepSuccess: document.getElementById('step-success'),
  stepError: document.getElementById('step-error'),

  // Step 1 — Select (çoklu dosya)
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),     // multiple
  fileQueue: document.getElementById('file-queue'),     // dosya listesi (eski #file-preview)
  bundleTitleInput: document.getElementById('bundle-title-input'),
  expireSelect: document.getElementById('expire-select'),
  maxSizeText: document.getElementById('max-size-text'),
  passwordToggle: document.getElementById('password-toggle'),
  passwordField: document.getElementById('password-field'),
  passwordInput: document.getElementById('password-input'),
  uploadBtn: document.getElementById('upload-btn'),

  // Upload Tray (sağ-alt köşe)
  uploadTray: document.getElementById('upload-tray'),
  uploadTrayBody: document.getElementById('upload-tray-body'),
  uploadTrayCount: document.getElementById('upload-tray-count'),
  trayMinimize: document.getElementById('tray-minimize'),
  trayClose: document.getElementById('tray-close'),

  // Step 2 — Uploading (batch bitince success'e geçer; upload sırasında
  // progress tray'de gösterilir, bu elementler sadece adaptör amaçlı kalır)
  uploadingIcon: document.getElementById('uploading-icon'),
  uploadingName: document.getElementById('uploading-name'),
  uploadingSize: document.getElementById('uploading-size'),
  progressFill: document.getElementById('progress-fill'),
  progressPercent: document.getElementById('progress-percent'),
  progressSpeed: document.getElementById('progress-speed'),
  progressEta: document.getElementById('progress-eta'),
  cancelUploadBtn: document.getElementById('cancel-upload-btn'),

  // Step 3 — Success
  expiryTime: document.getElementById('expiry-time'),
  directLinkUrl: document.getElementById('direct-link-url'),
  previewLinkUrl: document.getElementById('preview-link-url'),
  qrCanvas: document.getElementById('qr-canvas'),
  passwordInfo: document.getElementById('password-info'),
  newUploadBtn: document.getElementById('new-upload-btn'),

  // Step Error
  errorMessage: document.getElementById('error-message'),
  retryBtn: document.getElementById('retry-btn'),
  newUploadErrorBtn: document.getElementById('new-upload-error-btn'),

  // Toast
  toastContainer: document.getElementById('toast-container'),
};

// =========================================================================
// State — Batch upload (Task 13 refactor)
// =========================================================================
// Eski tek-dosya global state (selectedFile, xhr, abortController, fileId,
// chunkedMode, totalChunks, uploadedChunks, chunkBytesUploaded, uploadStartTime,
// lastLoaded, lastTime) artık yok — her batch kendi BatchUpload instance'ında
// tutar (this.activeXhrs, this.opts.bundleId, per-file fileId vb.).

window.FFBatches = new Map();      // batchId -> BatchUpload (aktif + tamamlanmış)
let pendingFiles = [];              // File[] — drop-zone'da seçili, henüz yüklenmemiş
const MAX_PARALLEL_FILES = 3;       // per-batch concurrency (paralel dosya)

let currentStep = 'select';

// Chunked upload chunk boyutu (config'den güncellenir) — tüm batchler共享
let chunkSizeBytes = 5 * 1024 * 1024; // Varsayılan 5MB

// Admin config'ten okunan ayarlar (proaktif frontend kontrolü için)
let configMaxFileSizeMB = 0;       // 0 = bilinmiyor/bilgi yok
let configAllowedMimeTypes = '*';  // '*' = tüm türler izinli
let configMaxExpireHours = 48;     // dropdown budama için

// i18n (aşağıda tanımlı t() tarafından kullanılır) — localStorage'dan dil
let currentLang = localStorage.getItem('filesfly_lang') || 'tr';

// =========================================================================
// Adım Yönetimi
// =========================================================================

function showStep(stepName) {
  currentStep = stepName;
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  const stepEl = document.getElementById(`step-${stepName}`);
  if (stepEl) stepEl.classList.add('active');
}

// =========================================================================
// Dosya Seçimi (Çoklu — kuyruk)
// =========================================================================
// Eski tek-dosya akışı (handleFileSelect + #file-preview) kaldırıldı.
// Artık drop-zone/file-input tüm dosyaları pendingFiles'a ekler, renderQueue()
// her dosya için satır (ikon/thumb + ad + boyut + kaldır butonu) çizer.

// Drop zone click → file input
DOM.dropZone.addEventListener('click', () => {
  DOM.fileInput.click();
});

// File input change — multiple: tüm dosyaları kuyruğa ekle
DOM.fileInput.addEventListener('change', () => {
  if (DOM.fileInput.files.length > 0) {
    appendFiles(DOM.fileInput.files);
    DOM.fileInput.value = ''; // aynı dosyaları tekrar seçmeye izin ver
  }
});

// Drag & drop
DOM.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  DOM.dropZone.classList.add('drag-over');
});

DOM.dropZone.addEventListener('dragleave', () => {
  DOM.dropZone.classList.remove('drag-over');
});

DOM.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  DOM.dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    appendFiles(e.dataTransfer.files);
  }
});

/**
 * Verilen FileList'i pendingFiles'a ekler, her birini doğrular ve kuyruğu yeniden
 * çizer. Geçersiz dosyalar uyarı satırıyla eklenir ama yükleme butonu buna göre
 * disable olur. Mevcut satırlar (aynı dosya tekrar seçilse bile) korunur — kullanıcı
 * kuyruğa istediği kadar dosya ekleyebilir.
 */
function appendFiles(fileList) {
  const willEncrypt = DOM.passwordToggle && DOM.passwordToggle.checked;
  for (const file of fileList) {
    pendingFiles.push(file);
  }
  renderQueue();
  // Upload butonu: en az bir geçerli dosya varsa aktif
  const anyValid = pendingFiles.some(f => validateSelectedFile(f));
  DOM.uploadBtn.disabled = !anyValid || pendingFiles.length === 0;
}

/**
 * MIME türünün admin'in allowed_mime_types ayarına göre izinli olup olmadığını
 * kontrol eder — backend isMimeTypeAllowed() mantığının client-side mirror'ı.
 * Amaç: kullanıcıyı backend'e kadar yormadan, seçim anında uyarabilmek.
 *
 * @param {string} mimeType - Dosyanın MIME türü (file.type)
 * @returns {boolean}
 */
function isMimeTypeAllowedClient(mimeType) {
  const allowed = configAllowedMimeTypes;
  if (!allowed || allowed === '*') return true;

  const mime = (mimeType || '').toLowerCase();
  // Boş MIME (örn. bazı tarayıcılarda uzantıdan çıkarsanamayan türler) → engellemeyelim,
  // backend zaten son sözü söyler. Sadece net bir şekilde izinli listede OLMAYANları
  // reddetmek istiyoruz.
  if (!mime) return true;

  const allowedTypes = allowed.split(',').map(s => s.trim().toLowerCase());
  for (const allowedType of allowedTypes) {
    if (allowedType === '*') return true;
    if (allowedType.endsWith('/*')) {
      const prefix = allowedType.replace('/*', '');
      if (mime.startsWith(prefix + '/')) return true;
    }
    if (allowedType === mime) return true;
  }
  return false;
}

/**
 * Seçilen dosyayı admin ayarlarına göre proaktif doğrular (boyut + MIME).
 * Hata varsa false döner; renderQueue satırında uyarı gösterilir. Backend tekrar
 * doğrulayacağı için bu sadece UX amaçlı (erken geri bildirim).
 *
 * @param {File} file
 * @returns {boolean} - true: doğrulandı (yüklenebilir), false: reddedildi
 */
function validateSelectedFile(file) {
  // --- Boyut kontrolü ---
  if (configMaxFileSizeMB > 0) {
    const maxSizeBytes = configMaxFileSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) return false;
  }

  // --- MIME kontrolü ---
  // Şifrelenmiş dosyalarda file.type octet-stream'a dönebilir; proaktif MIME kontrolünü
  // atla, backend zaten fields.mime_type üzerinden gerçek türü doğrular.
  const willEncrypt = DOM.passwordToggle && DOM.passwordToggle.checked;
  if (!willEncrypt && !isMimeTypeAllowedClient(file.type)) return false;

  return true;
}

/**
 * Kuyruktaki dosyalar için satır listesini (#file-queue) yeniden çizer.
 * Her satır: ikon/thumb (image→object URL, video→generateVideoThumbnail, else SVG)
 * + dosya adı + boyut + kaldır butonu. Geçersiz dosyalar için uyarı rozeti.
 *
 * Object URL'ler satır veri attribute'unda saklanır; satır kaldırılınca revoke edilir
 * (bellek sızıntısı önle).
 */
function renderQueue() {
  const queue = DOM.fileQueue;
  if (!queue) return;
  // Önceki satır object URL'lerini serbest bırak
  queue.querySelectorAll('[data-objurl]').forEach(el => {
    const u = el.getAttribute('data-objurl');
    if (u) URL.revokeObjectURL(u);
  });
  queue.innerHTML = '';

  if (pendingFiles.length === 0) {
    queue.classList.add('hidden');
    DOM.uploadBtn.disabled = true;
    return;
  }
  queue.classList.remove('hidden');

  const willEncrypt = DOM.passwordToggle && DOM.passwordToggle.checked;
  pendingFiles.forEach((file, idx) => {
    const valid = validateSelectedFile(file);
    const row = document.createElement('div');
    row.className = 'queue-row' + (valid ? '' : ' queue-row-invalid');
    row.setAttribute('role', 'listitem');
    row.dataset.idx = String(idx);

    // İkon alanı
    const iconWrap = document.createElement('span');
    iconWrap.className = 'queue-row-icon';
    iconWrap.innerHTML = getFileIcon(file.type, file.name);

    // image → thumbnail, video → asenkron thumbnail (üretilince değiştir)
    if (file.type.startsWith('image/')) {
      const u = URL.createObjectURL(file);
      iconWrap.setAttribute('data-objurl', u);
      iconWrap.innerHTML = `<img src="${u}" alt="${escapeHtml(file.name)}" class="preview-thumb">`;
    } else if (file.type.startsWith('video/')) {
      generateVideoThumbnail(file).then((thumbUrl) => {
        // Bu arada kuyruk değişmiş olabilir — bu satır hâlâ aynı dosyayı gösteriyorsa güncelle
        if (thumbUrl && queue.querySelector(`[data-idx="${idx}"]`) && pendingFiles[idx] === file) {
          iconWrap.setAttribute('data-objurl', thumbUrl);
          iconWrap.innerHTML = `<img src="${thumbUrl}" alt="${escapeHtml(file.name)}" class="preview-thumb">`;
        } else if (thumbUrl) {
          URL.revokeObjectURL(thumbUrl);
        }
      }).catch(() => { /* SVG ikon kalır */ });
    }

    // Ad + boyut
    const info = document.createElement('span');
    info.className = 'queue-row-info';
    info.innerHTML = `<span class="queue-row-name">${escapeHtml(file.name)}</span>` +
                     `<span class="queue-row-size">${formatSize(file.size)}${valid ? '' : ' · <span class="queue-row-warn">' + (currentLang === 'en' ? 'not allowed' : 'izinli değil') + '</span>'}</span>`;

    // Kaldır butonu
    const removeBtn = document.createElement('button');
    removeBtn.className = 'queue-row-remove';
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', currentLang === 'en' ? 'Remove file' : 'Dosyayı kaldır');
    removeBtn.innerHTML = '✕';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pendingFiles.splice(idx, 1);
      renderQueue();
    });

    row.appendChild(iconWrap);
    row.appendChild(info);
    row.appendChild(removeBtn);
    queue.appendChild(row);
  });
}

/**
 * Video dosyasından client-side ilk kareyi çıkarıp thumbnail (object URL) döndürür.
 * <video> elementine yükler, loadeddata event'inde canvas'a çizer, toBlob ile dışa aktarır.
 * Hiçbir harici bağımlılık (ffmpeg vb.) gerektirmez — tarayıcı yerel video decoding kullanır.
 *
 * @param {File} file - video dosyası
 * @returns {Promise<string|null>} - object URL (başarısızsa null)
 */
function generateVideoThumbnail(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const url = URL.createObjectURL(file);
    let settled = false;
    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      // video object URL'i serbest bırak (kendi thumbnail URL'imizi ayrıca oluşturacağız)
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      resolve(result);
    };

    // Bazı tarayıcılarda seek gerekir ki ilk kare gerçekten decode edilsin
    const capture = () => {
      try {
        // 1. saniyeye seek (film slatesinden kurtulmak için), ama süreyi aşma
        const seekTo = Math.min(1, (video.duration || 1) / 2 || 1);
        video.currentTime = seekTo;
      } catch {
        // seek desteklenmiyorsa mevcut kareyi yakala
        drawAndFinish();
      }
    };

    const drawAndFinish = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 160;
        canvas.height = video.videoHeight || 90;
        const ctx = canvas.getContext('2d');
        if (!ctx) return cleanup(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) return cleanup(null);
          cleanup(URL.createObjectURL(blob));
        }, 'image/jpeg', 0.8);
      } catch {
        cleanup(null);
      }
    };

    // seek tamamlandığında kareyi yakala
    video.addEventListener('seeked', drawAndFinish, { once: true });
    // loadeddata: ilk kare hazır → seek tetikle (seeked → capture)
    video.addEventListener('loadeddata', capture, { once: true });
    // Bazı tarayıcılarda loadeddata yerine canplay daha güvenilir
    video.addEventListener('canplay', capture, { once: true });

    // Güvenlik ağı: 5 saniye içinde kare yakalanamazsa vazgeç
    setTimeout(() => cleanup(null), 5000);

    // Hata: corrupt video / desteklenmeyen codec
    video.addEventListener('error', () => cleanup(null), { once: true });

    video.src = url;
  });
}

// Parola toggle — kuyruktaki MIME kontrolünü yeniden değerlendir (şifreli upload
// octet-stream olduğundan parola açıkken MIME kontrolü atlanır).
DOM.passwordToggle.addEventListener('change', () => {
  if (DOM.passwordToggle.checked) {
    DOM.passwordInput.removeAttribute('readonly');
    DOM.passwordInput.focus();
  } else {
    DOM.passwordInput.setAttribute('readonly', 'true');
    DOM.passwordInput.value = '';
  }
  // Kuyruk varsa yeniden çiz (geçerlilik rozetleri güncellenir)
  if (pendingFiles.length > 0) renderQueue();
});

// =========================================================================
// Dosya İkonu
// =========================================================================

function getFileIcon(mimeType, filename) {
  // Returns inline SVG HTML string for the given mime type
  const svg = (path, extra) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" ${extra||''}>${path}</svg>`;
  if (mimeType.startsWith('image/'))
    return svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
  if (mimeType.startsWith('video/'))
    return svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>');
  if (mimeType.startsWith('audio/'))
    return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
  if (mimeType.includes('pdf'))
    return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>');
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip'))
    return svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>');
  if (mimeType.includes('text') || mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml'))
    return svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
  if (mimeType.includes('word') || mimeType.includes('document'))
    return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>');
  if (mimeType.includes('sheet') || mimeType.includes('excel'))
    return svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>');
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint'))
    return svg('<path d="M3 3h18v12H3z"/><path d="M8 21l4-6 4 6"/><path d="M3 15h18"/>');
  return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
}

// =========================================================================
// Format Yardımcıları
// =========================================================================

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}sn`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk ${Math.ceil(seconds % 60)}sn`;
  return `${Math.floor(seconds / 3600)}sa ${Math.floor((seconds % 3600) / 60)}dk`;
}

// =========================================================================
// UUID Oluşturma (client-side, crypto.randomUUID)
// =========================================================================

function generateUUID() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: manual UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// =========================================================================
// BatchUpload — per-batch state + concurrent multi-file upload (Task 13)
// =========================================================================
// Eski tek-dosya global akış (startUpload/doSingleUpload/doChunkedUpload/
// uploadChunk/updateProgress/updateChunkProgress) BatchUpload metodlarına taşındı.
// Her batch kendi activeXhrs map'ini ve opts.bundleId'sini tutar. progress/speed/ETA
// math'i korundu ama artık batch bazlı çizer (tray kartı).

/**
 * Çoklu dosya yükleme batch'i. Bir bundle oluşturur (veya var olan bundleId'ye
 * katılır), dosyaları MAX_PARALLEL_FILES paralellikte yükler, tray'de kart gösterir.
 *
 * Instance alanları:
 *  - id: batch UUID (client-side)
 *  - files: File[] (yüklenmemiş dosyalar; başlatınca queue olarak tüketilir)
 *  - opts: { expireHours, password, title, bundleId, passwordSalt }
 *  - status: 'pending'|'uploading'|'paused'|'done'|'partial'|'error'|'cancelled'
 *  - progress: 0-100 (tamamlanan byte / toplam byte)
 *  - completedFiles: [{ file, meta }] — meta backend upload response
 *  - failedFiles: [{ file, error }]
 *  - activeXhrs: Map<fileId, XMLHttpRequest|AbortController> — abort için
 *  - startedAt: timestamp
 *  - shareUrl: /b/:bundleId tam URL
 */
class BatchUpload {
  constructor(files, opts = {}) {
    this.id = (crypto.randomUUID ? crypto.randomUUID() : 'b-' + Date.now());
    this.files = files ? Array.from(files) : [];
    this.opts = opts; // { expireHours, password, title, bundleId, passwordSalt }
    this.status = 'pending';
    this.progress = 0;
    this.completedFiles = [];
    this.failedFiles = [];
    this.activeXhrs = new Map();
    this.startedAt = 0;
    this.shareUrl = null;
  }

  /**
   * Bundle oluştur (yoksa) ve dosyaları paralel yükle. Bitince status'u
   * done/partial/error olarak işaretler, persistBatches + renderTray çağırır.
   * Tüm batch bitince success step'e geçer (handleBatchSuccess).
   */
  async start() {
    if (this.status === 'cancelled') return;
    this.status = 'uploading';
    this.startedAt = Date.now();
    renderTray();

    // Session cookie kontrolü — yoksa önce session oluştur
    try {
      await ensureSession();
    } catch (err) {
      dbg.error('session', 'Session creation failed', err);
      showToast(t('sessionError'), 'error');
      this.status = 'error';
      persistBatches(); renderTray();
      return;
    }

    // Bundle oluştur (bundleId verilmediyse)
    if (!this.opts.bundleId) {
      dbg.info('bundle', 'POST /api/bundles creating', { expire: this.opts.expireHours, title: this.opts.title });
      try {
        const r = await fetch('/api/bundles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expire: this.opts.expireHours,
            title: this.opts.title || null,
            password: this.opts.password || null,
          }),
        });
        if (!r.ok) {
          const errData = await r.json().catch(() => ({}));
          dbg.error('bundle', `Bundle create HTTP ${r.status}`, errData);
          this.status = 'error';
          this.failedFiles = this.files.map(f => ({ file: f, error: errData.error || `Bundle create failed: ${r.status}` }));
          persistBatches(); renderTray();
          handleUploadError(errData.error || 'Bundle oluşturulamadı.');
          return;
        }
        const b = await r.json();
        this.opts.bundleId = b.bundle_id;
        this.opts.passwordSalt = b.password_salt;
        this.shareUrl = `${location.origin}/b/${b.bundle_id}`;
        dbg.info('bundle', `✓ Bundle created`, { bundleId: b.bundle_id });
      } catch (err) {
        dbg.error('bundle', 'Bundle create network error', err);
        this.status = 'error';
        this.failedFiles = this.files.map(f => ({ file: f, error: err.message }));
        persistBatches(); renderTray();
        handleUploadError(t('connectionError'));
        return;
      }
    } else {
      this.shareUrl = `${location.origin}/b/${this.opts.bundleId}`;
    }
    persistBatches();
    renderTray();

    // Paralel yükleme: MAX_PARALLEL_FILES worker queue'yu tüketir
    const queue = [...this.files];
    dbg.group('batch', `Batch ${this.id} start: ${this.files.length} files, ${MAX_PARALLEL_FILES} parallel`);
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_FILES, queue.length) }, async () => {
      while (queue.length) {
        if (this.status === 'paused' || this.status === 'cancelled') break;
        const file = queue.shift();
        try {
          await this.uploadOne(file);
        } catch (e) {
          dbg.error('batch', `File failed: ${file.name}`, e);
          this.failedFiles.push({ file, error: e.message || String(e) });
        }
        this.updateProgress();
        renderTray();
      }
    });
    await Promise.all(workers);
    dbg.groupEnd('batch');

    if (this.status === 'cancelled') return; // cancel() zaten temizledi
    if (this.failedFiles.length === 0) this.status = 'done';
    else if (this.completedFiles.length > 0) this.status = 'partial';
    else this.status = 'error';
    persistBatches();
    renderTray();

    // Success step: batch tamamlandıysa (en az bir dosya) link göster
    if (this.completedFiles.length > 0) {
      handleBatchSuccess(this);
    } else {
      handleUploadError(this.failedFiles[0]?.error || 'Yükleme başarısız.');
    }
  }

  /**
   * Tek dosya yükle: parola varsa şifrele (bundle ortak salt kullan), sonra send().
   * Başarılı meta'yı completedFiles'a ekler. Hata fırlatırsa start() yakalar.
   */
  async uploadOne(file) {
    dbg.log('batch', `Uploading: ${file.name} (${formatSize(file.size)})`);
    let data = file;
    let encIV = null;
    let encSalt = null;
    const originalMimeType = file.type || 'application/octet-stream';

    if (this.opts.password && this.opts.password.length > 0) {
      dbg.info('encrypt', `Encrypting ${file.name} (AES-256-GCM)`);
      const enc = await encryptFile(file, this.opts.password);
      data = enc.ciphertext;
      encIV = enc.iv;
      // Bundle ortak salt varsa onu kullan (tek parola tüm dosyaları açar),
      // yoksa per-file salt enc.salt.
      encSalt = this.opts.passwordSalt || enc.salt;
    }
    const meta = await this.send(file, data, encIV, encSalt, originalMimeType);
    this.completedFiles.push({ file, meta });
    dbg.info('batch', `✓ ${file.name} done`, { id: meta.id });
  }

  /**
   * Dosya boyutuna göre tek seferde (XHR) veya chunked (fetch) upload dispatch.
   */
  async send(file, data, encIV, encSalt, originalMimeType) {
    const chunkSize = chunkSizeBytes || (5 * 1024 * 1024);
    if (data.size <= chunkSize) return this.singleUpload(file, data, encIV, encSalt, originalMimeType);
    return this.chunkedUpload(file, data, encIV, encSalt, originalMimeType);
  }

  // -----------------------------------------------------------------------
  // Tek seferde upload (küçük dosyalar — XHR). Eski doSingleUpload'tan uyarlandı.
  // this.opts.bundleId form alanına eklenir, xhr this.activeXhrs'a kaydedilir.
  // -----------------------------------------------------------------------
  singleUpload(file, data, encIV, encSalt, originalMimeType) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', data, file.name);
      formData.append('expire', String(this.opts.expireHours));
      formData.append('bundle_id', this.opts.bundleId);
      if (this.opts.password) {
        formData.append('password', this.opts.password);
        formData.append('encryption_iv', encIV);
        formData.append('encryption_salt', encSalt);
        formData.append('mime_type', originalMimeType);
      }

      dbg.info('upload', `XHR POST /api/upload: ${file.name}`, { size: data.size, encrypted: !!this.opts.password });
      const xhr = new XMLHttpRequest();
      this.activeXhrs.set(file.name + ':single', xhr);

      // Per-file progress → batch progress (tamamlanan dosya byte'ı eklenir)
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          // Anlık progress: tamamlanan dosyalar + bu dosyanın loaded'ı
          const doneBytes = this.completedFiles.reduce((a, f) => a + f.file.size, 0) + e.loaded;
          const totalBytes = this.files.reduce((a, f) => a + f.size, 0);
          this.progress = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
          renderTray();
        }
      });

      xhr.addEventListener('load', () => {
        this.activeXhrs.delete(file.name + ':single');
        const status = xhr.status;
        const txt = xhr.responseText;
        dbg.info('upload', `XHR response: HTTP ${status} (${file.name})`);
        if (status >= 200 && status < 300) {
          try { resolve(JSON.parse(txt)); }
          catch { reject(new Error(t('serverResponseError'))); }
        } else {
          try {
            const err = JSON.parse(txt);
            reject(new Error(err.error || `Hata: ${status}`));
          } catch {
            reject(new Error(`Sunucu hatası: ${status}`));
          }
        }
      });
      xhr.addEventListener('error', () => {
        this.activeXhrs.delete(file.name + ':single');
        reject(new Error(t('connectionError')));
      });
      xhr.addEventListener('abort', () => {
        this.activeXhrs.delete(file.name + ':single');
        reject(new Error('aborted'));
      });

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
    });
  }

  // -----------------------------------------------------------------------
  // Chunked upload (büyük dosyalar — fetch). Eski doChunkedUpload/uploadChunk'tan
  // uyarlandı. Per-file fileId, this.activeXhrs AbortController, this.opts.bundleId.
  // Resume: GET /api/upload/chunk/:id/status ile kaldığı yerden devam eder.
  // -----------------------------------------------------------------------
  async chunkedUpload(file, data, encIV, encSalt, originalMimeType) {
    const chunkFileId = generateUUID();
    const totalChunks = Math.ceil(data.size / chunkSizeBytes);
    let uploadedChunks = 0;
    let chunkBytesUploaded = 0;
    const abortCtrl = new AbortController();
    this.activeXhrs.set(file.name + ':chunk', abortCtrl);

    dbg.info('chunk', `Chunked upload init: ${file.name}`, { fileId: chunkFileId, totalChunks, chunkSize: chunkSizeBytes, totalSize: data.size });

    // Resume kontrolü
    try {
      const statusResp = await fetch(`/api/upload/chunk/${chunkFileId}/status`, { signal: abortCtrl.signal });
      if (statusResp.ok) {
        const status = await statusResp.json();
        if (status.exists && status.received_chunks > 0) {
          uploadedChunks = status.received_chunks;
          dbg.info('chunk', `Resume: ${uploadedChunks}/${totalChunks} chunks already uploaded (${file.name})`);
          const fullChunkSize = chunkSizeBytes;
          chunkBytesUploaded = (uploadedChunks - 1) < totalChunks - 1
            ? uploadedChunks * fullChunkSize
            : Math.min(uploadedChunks * fullChunkSize, data.size);
          showToast(`${uploadedChunks}/${totalChunks} ${t('chunkResume')}`, 'info');
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') { this.activeXhrs.delete(file.name + ':chunk'); throw new Error('aborted'); }
      dbg.warn('chunk', `Resume status fetch failed (${file.name}), starting fresh`, err.message);
    }

    // Chunk loop
    for (let i = uploadedChunks; i < totalChunks; i++) {
      if (abortCtrl.signal.aborted || this.status === 'paused' || this.status === 'cancelled') {
        this.activeXhrs.delete(file.name + ':chunk');
        throw new Error('aborted');
      }
      const start = i * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, data.size);
      const chunk = data.slice(start, end);
      const result = await this.uploadChunk(file, chunkFileId, i, totalChunks, chunk, data, encIV, encSalt, originalMimeType, abortCtrl);
      if (!result) {
        this.activeXhrs.delete(file.name + ':chunk');
        throw new Error(`${t('chunkFailed')} (${i + 1}/${totalChunks})`);
      }
      uploadedChunks++;
      chunkBytesUploaded += chunk.size;
      // Per-file progress → batch progress
      const doneBytes = this.completedFiles.reduce((a, f) => a + f.file.size, 0) + chunkBytesUploaded;
      const totalBytes = this.files.reduce((a, f) => a + f.size, 0);
      this.progress = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
      renderTray();
      // Son chunk → result.complete=true, dosya metadata içerir
      if (result.complete) {
        this.activeXhrs.delete(file.name + ':chunk');
        return result;
      }
    }
    this.activeXhrs.delete(file.name + ':chunk');
    // Tüm chunklar bitti ama complete gelmedi (teorik) → hata
    throw new Error('Chunk upload tamamlanamadı.');
  }

  /**
   * Tek bir chunk'ı fetch ile gönderir. Eski uploadChunk'tan uyarlandı.
   * this.opts.bundleId + this.opts.expireHours form alanlarına eklenir.
   * Retry: 3 kez, üstel bekleme.
   * @returns {Promise<object|null>} - response JSON (complete:true içerebilir) veya null (hata)
   */
  async uploadChunk(file, chunkFileId, chunkIndex, totalChunks, chunk, data, encIV, encSalt, originalMimeType, abortCtrl) {
    const formData = new FormData();
    formData.append('chunk', chunk, `chunk_${chunkIndex}`);
    formData.append('chunk_index', String(chunkIndex));
    formData.append('total_chunks', String(totalChunks));
    formData.append('file_id', chunkFileId);
    formData.append('filename', file.name);
    formData.append('expire', String(this.opts.expireHours));
    formData.append('bundle_id', this.opts.bundleId);
    if (this.opts.password) {
      formData.append('password', this.opts.password);
      formData.append('encryption_iv', encIV);
      formData.append('encryption_salt', encSalt);
      formData.append('mime_type', originalMimeType);
    }

    let retries = 0;
    const maxRetries = 3;
    while (retries <= maxRetries) {
      try {
        dbg.log('chunk', `Chunk ${chunkIndex + 1}/${totalChunks} → POST /api/upload/chunk (${file.name}, attempt ${retries + 1})`);
        const resp = await fetch('/api/upload/chunk', {
          method: 'POST',
          body: formData,
          signal: abortCtrl.signal,
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          dbg.error('chunk', `Chunk ${chunkIndex + 1} HTTP ${resp.status}`, errData);
          // Kotası aşım gibi kalıcı hatalar → retry yapma
          if (resp.status === 507 || resp.status === 413 || resp.status === 415) {
            throw new Error(errData.error || `Chunk upload error: ${resp.status}`);
          }
          throw new Error(errData.error || `Chunk upload error: ${resp.status}`);
        }
        const result = await resp.json();
        if (result.complete) {
          dbg.info('chunk', `✓ Last chunk (${chunkIndex + 1}/${totalChunks}) — complete (${file.name})`, { id: result.id });
        }
        return result;
      } catch (err) {
        if (err.name === 'AbortError') {
          dbg.warn('chunk', `Chunk ${chunkIndex + 1} aborted (${file.name})`);
          return null;
        }
        // Kalıcı hata (quota/size/mime) → retry yapma
        if (err.message && (err.message.includes('quota') || err.message.includes('exceeds maximum') || err.message.includes('not allowed'))) {
          dbg.error('chunk', `Chunk ${chunkIndex + 1} permanent error (${file.name})`, err.message);
          throw err;
        }
        retries++;
        if (retries > maxRetries) {
          dbg.error('chunk', `Chunk ${chunkIndex + 1} failed after ${maxRetries + 1} attempts (${file.name})`, err);
          return null;
        }
        dbg.warn('chunk', `Chunk ${chunkIndex + 1} retry ${retries}/${maxRetries} (${file.name}) — wait ${1000 * retries}ms`, err.message);
        await new Promise(r => setTimeout(r, 1000 * retries));
      }
    }
    return null;
  }

  /**
   * Batch progress: tamamlanan dosya byte'ı / toplam byte.
   */
  updateProgress() {
    const doneBytes = this.completedFiles.reduce((a, f) => a + f.file.size, 0);
    const totalBytes = this.files.reduce((a, f) => a + f.size, 0);
    this.progress = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  }

  /** Aktif xhr'ları abort ederek duraklat. Resume() ile devam eder. */
  pause() {
    if (this.status !== 'uploading') return;
    this.status = 'paused';
    this.activeXhrs.forEach(c => { try { c.abort(); } catch { /* ignore */ } });
    this.activeXhrs.clear();
    persistBatches(); renderTray();
    showToast('Yükleme duraklatıldı.', 'info');
  }

  /** Duraklatılan batch'i devam ettir. Tamamlanmamış dosyaları yeniden yükler. */
  resume() {
    if (this.status !== 'paused') return;
    // Tamamlanmamış dosyalar: failedFiles + henüz yüklenmemiş dosyalar
    const done = new Set(this.completedFiles.map(f => f.file.name + f.file.size + f.file.lastModified));
    const remaining = this.files.filter(f => !done.has(f.name + f.size + f.lastModified));
    this.files = remaining;
    this.failedFiles = [];
    this.start();
  }

  /** İptal: xhr'ları abort et, FFBatches'ten sil, tray'i yenile. */
  cancel() {
    this.status = 'cancelled';
    this.activeXhrs.forEach(c => { try { c.abort(); } catch { /* ignore */ } });
    this.activeXhrs.clear();
    window.FFBatches.delete(this.id);
    persistBatches(); renderTray();
    showToast(t('uploadCancelled'), 'info');
  }
}
window.BatchUpload = BatchUpload;

// =========================================================================
// Yükleme Butonu → BatchUpload oluştur + başlat
// =========================================================================

DOM.uploadBtn.addEventListener('click', () => {
  if (pendingFiles.length === 0) return;
  // Geçerli dosyaları filtrele (boyut/MIME); geçersizleri atla
  const filesToUpload = pendingFiles.filter(f => validateSelectedFile(f));
  if (filesToUpload.length === 0) {
    showToast(currentLang === 'en' ? 'No valid files to upload.' : 'Yüklenecek geçerli dosya yok.', 'error');
    return;
  }
  const opts = {
    expireHours: parseInt(DOM.expireSelect?.value || '1', 10),
    password: DOM.passwordToggle?.checked ? (DOM.passwordInput?.value || null) : null,
    title: DOM.bundleTitleInput?.value?.trim() || null,
  };
  dbg.group('batch', `New BatchUpload: ${filesToUpload.length} files`, opts);
  const batch = new BatchUpload(filesToUpload, opts);
  window.FFBatches.set(batch.id, batch);
  pendingFiles = [];
  renderQueue();
  DOM.uploadBtn.disabled = true;
  showTray();
  batch.start();
});

async function ensureSession() {
  // Cookie'de session var mı?
  if (getCookie('filesfly_sid')) {
    dbg.log('session', 'Session cookie present, no need to create new session');
    return;
  }
  dbg.info('session', 'No session, POST /api/session creating...');
  const resp = await fetch('/api/session', { method: 'POST' });
  if (!resp.ok) {
    dbg.error('session', 'Session creation failed', { status: resp.status });
    throw new Error('Session creation failed');
  }
  dbg.info('session', '✓ Session created (cookie set)');
}

// =========================================================================
// Upload Tray — sağ-alt köşede batch kartları
// =========================================================================

/**
 * #upload-tray-body içine her batch için bir kart çizer: ad, durum, progress bar,
 * meta (completed/total · %), aksiyon butonları (copy-link / pause / resume / cancel).
 * Event delegation: buton tıklamaları data-pause/data-resume/data-cancel/data-copy
 * attribute'larından dispatch edilir.
 */
function renderTray() {
  const body = DOM.uploadTrayBody;
  if (!body) return;
  body.innerHTML = '';

  // Event delegation (her render'da yeniden bağlanır — innerHTML temizlediği için)
  body.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const batch = [...window.FFBatches.values()].find(b =>
      b.id === btn.dataset.pause || b.id === btn.dataset.resume || b.id === btn.dataset.cancel);
    if (btn.dataset.copy) {
      copyToClipboard(btn.dataset.copy);
      btn.textContent = 'Kopyalandı!';
      setTimeout(() => { btn.textContent = 'Linki kopyala'; }, 1500);
      return;
    }
    if (btn.dataset.pause && batch) { batch.pause(); return; }
    if (btn.dataset.resume && batch) { batch.resume(); return; }
    if (btn.dataset.cancel && batch) { batch.cancel(); return; }
  };

  for (const b of window.FFBatches.values()) {
    const card = document.createElement('div');
    card.className = 'tray-batch-card';
    const name = b.opts?.title || b.shareUrl?.split('/').pop() || (currentLang === 'en' ? 'Batch' : 'Batch');
    const statusLabel = trayStatusLabel(b.status, currentLang);
    const pct = b.progress || 0;
    card.innerHTML = `
      <div class="tray-batch-top">
        <span class="tray-batch-name">${escapeHtml(name)}</span>
        <span class="tray-batch-status">${statusLabel}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="tray-batch-meta">${b.completedFiles.length}/${b.files.length} · %${pct}</div>
      <div class="tray-batch-actions">
        ${b.status === 'done' && b.shareUrl ? `<button class="tray-btn" data-copy="${escapeHtml(b.shareUrl)}">Linki kopyala</button>` : ''}
        ${b.status === 'partial' && b.shareUrl ? `<button class="tray-btn" data-copy="${escapeHtml(b.shareUrl)}">Linki kopyala</button>` : ''}
        ${b.status === 'uploading' ? `<button class="tray-btn" data-pause="${b.id}">Durdur</button>` : ''}
        ${b.status === 'paused' ? `<button class="tray-btn" data-resume="${b.id}">Devam</button>` : ''}
        ${b.status !== 'done' && b.status !== 'cancelled' ? `<button class="tray-btn" data-cancel="${b.id}">İptal</button>` : ''}
      </div>`;
    body.appendChild(card);
  }

  // Tray count: aktif (uploading/paused/pending) batch sayısı
  const activeCount = [...window.FFBatches.values()].filter(b => ['uploading', 'paused', 'pending'].includes(b.status)).length;
  if (DOM.uploadTrayCount) DOM.uploadTrayCount.textContent = activeCount > 0 ? String(activeCount) : '';
}

function trayStatusLabel(status, lang) {
  const tr = {
    pending: 'Bekliyor', uploading: 'Yükleniyor', paused: 'Duraklatıldı',
    done: 'Tamamlandı', partial: 'Kısmen', error: 'Hata', cancelled: 'İptal',
  };
  const en = {
    pending: 'Pending', uploading: 'Uploading', paused: 'Paused',
    done: 'Done', partial: 'Partial', error: 'Error', cancelled: 'Cancelled',
  };
  return (lang === 'en' ? en : tr)[status] || status;
}

/** Tray'i görünür yap (yeni batch başlatınca çağrılır). */
function showTray() {
  if (DOM.uploadTray) DOM.uploadTray.classList.remove('hidden');
}

// Tray kontrolleri
if (DOM.trayMinimize) {
  DOM.trayMinimize.addEventListener('click', () => {
    DOM.uploadTray.classList.toggle('minimized');
  });
}
if (DOM.trayClose) {
  DOM.trayClose.addEventListener('click', () => {
    const active = [...window.FFBatches.values()].some(b => ['uploading', 'paused', 'pending'].includes(b.status));
    if (!active) {
      DOM.uploadTray.classList.add('hidden');
    } else {
      showToast('Aktif yükleme var, kapatılamaz.', 'error');
    }
  });
}

// =========================================================================
// localStorage Kalıcılık (reload sonrası link kopyalama)
// =========================================================================

/**
 * FFBatches'i localStorage'a serileştirir. File nesneleri serileştirilemez,
 * bu yüzden sadece meta (ad/boyut/tür) + durum + shareUrl saklanır. Reload sonrası
 * completed/partial kartlar read-only (link kopyalama) olarak gösterilir; upload
 * byte-level resume mümkün değil (kullanıcı dosyaları yeniden seçmeli).
 */
function persistBatches() {
  try {
    const serial = [...window.FFBatches.values()].map(b => ({
      id: b.id,
      status: b.status,
      progress: b.progress,
      files: b.files.map(f => ({ name: f.name, size: f.size, type: f.type })),
      opts: { expireHours: b.opts?.expireHours, title: b.opts?.title, bundleId: b.opts?.bundleId },
      shareUrl: b.shareUrl,
      completed: b.completedFiles.length,
      failed: b.failedFiles.length,
    }));
    localStorage.setItem('ff_batches', JSON.stringify(serial));
  } catch { /* quota exceeded — sessiz geç */ }
}

/**
 * localStorage'dan batch'leri geri yükle (sadece completed/partial — read-only).
 * Aktif upload'lar resume edilemez (File nesnesi yok); onlar 'interrupted' olarak
 * gösterilip kullanıcı yeniden seçmeye yönlendirilir. Pragmatik: sadece link
 * kopyalama kartlarını geri yükle.
 */
function restoreBatches() {
  let serial = [];
  try { serial = JSON.parse(localStorage.getItem('ff_batches') || '[]'); } catch { return; }
  if (!Array.isArray(serial) || serial.length === 0) return;
  for (const s of serial) {
    // Sadece completed/partial kartlarını geri yükle (link kopyalama amaçlı)
    if (s.status !== 'done' && s.status !== 'partial') continue;
    // File nesneleri olmadan gerçek BatchUpload instance oluşturulamaz; minimal
    // stub nesne tray'de gösterebilmek için (renderTray b.files.length kullanır)
    const stub = {
      id: s.id,
      files: (s.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
      opts: s.opts || {},
      status: s.status,
      progress: s.progress || 100,
      completedFiles: Array(s.completed || 0).fill({ file: { size: 0 } }),
      failedFiles: Array(s.failed || 0).fill({}),
      shareUrl: s.shareUrl,
      activeXhrs: new Map(),
    };
    window.FFBatches.set(stub.id, stub);
  }
  if (window.FFBatches.size > 0) {
    renderTray();
    showTray();
  }
}

// =========================================================================
// Başarılı Yükleme (batch tamamlandı → success step)
// =========================================================================

/**
 * Batch tamamlandıysa success step'e geçer. Eski handleUploadSuccess mantığı
 * uyarlandı: direct-link = ilk tamamlanan dosyanın direct_url, preview-link =
 * batch.shareUrl (/b/:bundleId), QR batch shareUrl üzerinde. Çoklu dosyada
 * bundle linki öne çıkarılır.
 */
function handleBatchSuccess(batch) {
  const first = batch.completedFiles[0];
  if (!first) return;
  const result = first.meta;
  dbg.group('batch', '✓ Batch complete!', { batchId: batch.id, completed: batch.completedFiles.length, failed: batch.failedFiles.length });

  showStep('success');

  const origin = window.location.origin;
  // direct_url: ilk dosyanın indirme linki
  const directFull = result.direct_url?.startsWith('http') ? result.direct_url : origin + (result.direct_url || '');
  // preview-link: batch shareUrl (bundle sayfası)
  const previewFull = batch.shareUrl || '';

  DOM.directLinkUrl.textContent = directFull;
  DOM.previewLinkUrl.textContent = previewFull;

  // Canlı countdown (ilk dosyanın expire_at'i — bundle expire'ı yakın)
  if (result.expire_at) startLiveCountdown(result.expire_at);
  // İndirme sayacı (ilk dosya)
  if (result.id) startDownloadCounter(result.id);

  // QR Kod: batch shareUrl üzerinde (tek link tüm dosyalar)
  generateQR(previewFull);

  // QR Kopyalama butonu
  const qrCopyBtn = document.getElementById('qr-copy-btn');
  if (qrCopyBtn) {
    qrCopyBtn.replaceWith(qrCopyBtn.cloneNode(true)); // eski listener'ları temizle
    const newBtn = document.getElementById('qr-copy-btn');
    if (newBtn) newBtn.addEventListener('click', () => copyQRToClipboard());
  }

  // E-posta paylaşım linki (batch linki ile)
  updateEmailShareLink(previewFull, batch.opts?.title || (batch.files[0]?.name || 'dosya'));

  // Parola bilgisi
  if (result.is_encrypted) {
    DOM.passwordInfo?.classList.remove('hidden');
  } else {
    DOM.passwordInfo?.classList.add('hidden');
  }

  // i18n güncelle
  applyTranslations();

  // Link kopyalama butonları (success step içindeki data-copy butonları)
  document.querySelectorAll('#step-success [data-copy]').forEach(btn => {
    btn.replaceWith(btn.cloneNode(true)); // eski listener'ları temizle
  });
  document.querySelectorAll('#step-success [data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copy;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        copyToClipboard(targetEl.textContent);
        btn.dataset.copied = '1';
        btn.textContent = t('copied');
        setTimeout(() => {
          btn.dataset.copied = '0';
          btn.textContent = t('copyBtn');
        }, 2000);
      }
    });
  });

  // Eğer session sayfasındaysak, dosya listesini yenile
  if (typeof loadFiles === 'function') {
    setTimeout(() => loadFiles(), 500);
  }
}

/**
 * Tek dosya başarı durumunda (legacy / sadece ilk dosya) success step doldurur.
 * Eski handleUploadSuccess'in batch-bağımsız kısmı — şimdilik handleBatchSuccess
 * tarafından çağrılmıyor ama arayüz uyumu için korundu.
 */
function handleUploadSuccess(result) {
  dbg.group('upload', '✓ Upload successful!', {
    id: result.id, filename: result.filename, direct_url: result.direct_url,
    preview_url: result.preview_url, is_encrypted: result.is_encrypted, expire_at: result.expire_at,
  });
  showStep('success');
  const origin = window.location.origin;
  const directFull = result.direct_url?.startsWith('http') ? result.direct_url : origin + (result.direct_url || '');
  const previewFull = result.preview_url?.startsWith('http') ? result.preview_url : origin + (result.preview_url || '');
  DOM.directLinkUrl.textContent = directFull;
  DOM.previewLinkUrl.textContent = previewFull;
  if (result.expire_at) startLiveCountdown(result.expire_at);
  if (result.id) startDownloadCounter(result.id);
  generateQR(directFull);
  const qrCopyBtn = document.getElementById('qr-copy-btn');
  if (qrCopyBtn) {
    qrCopyBtn.replaceWith(qrCopyBtn.cloneNode(true));
    const newBtn = document.getElementById('qr-copy-btn');
    if (newBtn) newBtn.addEventListener('click', () => copyQRToClipboard());
  }
  updateEmailShareLink(directFull, result.filename);
  if (result.is_encrypted) DOM.passwordInfo?.classList.remove('hidden');
  else DOM.passwordInfo?.classList.add('hidden');
  applyTranslations();
  if (typeof loadFiles === 'function') setTimeout(() => loadFiles(), 500);
}

// QR Kod oluştur
function generateQR(url) {
  // QRious global olarak CDN'den yüklenmiş olmalı
  if (typeof QRious === 'undefined') {
    if (DOM.qrCanvas) DOM.qrCanvas.parentElement.classList.add('hidden');
    return;
  }
  if (!DOM.qrCanvas || !url) return;
  new QRious({
    element: DOM.qrCanvas,
    value: url,
    size: 120,
    background: '#ffffff',
    foreground: '#0A0A0A',
    level: 'M',
  });
}

// =========================================================================
// Hata Yönetimi
// =========================================================================

/**
 * Upload hatası → error step. Quota aşımı (mesaj 'quota' içerir) zengin uyarı.
 */
function handleUploadError(message) {
  dbg.error('upload', '✕ Upload error', message);
  showStep('error');
  if (message && typeof message === 'string' && message.includes('quota')) {
    DOM.errorMessage.textContent = t('quotaFull');
  } else {
    DOM.errorMessage.textContent = message;
  }
}

// Retry — batch error sonrası drop-zone'a dön
DOM.retryBtn.addEventListener('click', () => {
  resetToSelect();
});

// Yeni dosya (error sayfasından)
DOM.newUploadErrorBtn.addEventListener('click', resetToSelect);

// Yeni dosya (success sayfasından)
DOM.newUploadBtn.addEventListener('click', resetToSelect);

/**
 * Select step'e sıfırla: kuyruğu temizle, parola alanını kilitle, intervals'ları
 * temizle. Eski tek-dosya state (selectedFile/fileId/chunkedMode) kaldırıldı.
 */
function resetToSelect() {
  pendingFiles = [];
  if (DOM.fileQueue) DOM.fileQueue.innerHTML = '';
  if (DOM.fileQueue) DOM.fileQueue.classList.add('hidden');
  DOM.fileInput.value = '';
  DOM.uploadBtn.disabled = true;
  DOM.passwordToggle.checked = false;
  // Parola alanı opsiyonel — bazı sayfalarda #password-field yok (always-visible input).
  if (DOM.passwordField) DOM.passwordField.classList.add('hidden');
  if (DOM.passwordInput) {
    DOM.passwordInput.value = '';
    DOM.passwordInput.readOnly = true;
  }
  // Bundle title input'u temizle
  if (DOM.bundleTitleInput) DOM.bundleTitleInput.value = '';
  // Clear intervals
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (downloadPollInterval) { clearInterval(downloadPollInterval); downloadPollInterval = null; }
  showStep('select');
}

// =========================================================================
// Clipboard
// =========================================================================

// QR Kod'u panoya kopyala
function copyQRToClipboard() {
  const canvas = DOM.qrCanvas;
  if (!canvas) return;

  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('QR kod kopyalanamadı.', 'error');
        return;
      }
      try {
        const item = new ClipboardItem({ 'image/png': blob });
        navigator.clipboard.write([item]).then(() => {
          showToast('QR kod kopyalandı!', 'success');
        }).catch(() => {
          showToast('QR kod kopyalanamadı.', 'error');
        });
      } catch {
        showToast('Tarayıcınız resim kopyalamayı desteklemiyor.', 'error');
      }
    }, 'image/png');
  } catch {
    showToast('QR kod kopyalanamadı.', 'error');
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(t('copySuccess'), 'success');
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast(t('copySuccess'), 'success');
  } catch {
    showToast(t('copyFailed'), 'error');
  }
  document.body.removeChild(textarea);
}

// =========================================================================
// Toast Notification
// =========================================================================

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const icons = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" class="icon-success"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" class="icon-error"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" class="icon-info"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  toast.innerHTML = `<span aria-hidden="true">${icons[type] || icons.info}</span> ${message}`;

  DOM.toastContainer.appendChild(toast);

  // 3 saniye sonra kaldır
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// =========================================================================
// Cookie Yardımcısı
// =========================================================================

function getCookie(name) {
  const cookies = document.cookie.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, ...valParts] = cookie.split('=');
    if (key === name) {
      return decodeURIComponent(valParts.join('='));
    }
  }
  return null;
}

// =========================================================================
// Web Crypto API — AES-GCM Parola Koruması (Faz 4.3)
// =========================================================================
// Şifreleme/deşifreleme mantığı artık paylaşımlı /js/crypto.js (FFCrypto)
// içinde. app.js, file.js ve admin.js aynı yardımcıyı kullanır — kod tekrarı
// yok ve parola gate ile tutarlı çalışır.

/**
 * Dosyayı AES-GCM ile şifreler (FFCrypto'ya delege).
 * @param {File|Blob} file - Şifrelenecek dosya
 * @param {string} password - Parola
 * @returns {Promise<{ciphertext: Blob, iv: string, salt: string}>}
 */
async function encryptFile(file, password) {
  return FFCrypto.encryptFile(file, password);
}

/**
 * Şifreli dosyayı AES-GCM ile çözer (FFCrypto'ya delege).
 */
async function decryptFile(ciphertext, ivBase64, saltBase64, password) {
  return FFCrypto.decryptFile(ciphertext, ivBase64, saltBase64, password);
}

// =========================================================================
// Parola Çözme (Faz 4.4 — Decrypt UI)
// =========================================================================

/**
 * Sayfa yüklendiğinde URL'de file ID varsa ve is_encrypted=true ise
 * decrypt adımını gösterir.
 */
async function checkDecryptMode() {
  // URL pattern: /files/:id veya /files/:id/dl
  const path = window.location.pathname;
  const fileMatch = path.match(/^\/api\/files\/([a-f0-9-]+)(\/dl)?$/);
  if (!fileMatch) return;

  const fileId = fileMatch[1];
  const isDownload = !!fileMatch[2];

  try {
    const resp = await fetch(`/api/files/${fileId}`);
    if (!resp.ok) return;

    const metadata = await resp.json();

    if (metadata.is_encrypted) {
      showDecryptUI(fileId, metadata, isDownload);
    }
  } catch {
    // Metadata alınamazsa normal akışa devam et
  }
}

/**
 * Parola çözme UI'ını gösterir.
 */
function showDecryptUI(fileId, metadata, isDownload) {
  // Ana container'ı gizle, decrypt container'ı göster
  const mainContainer = document.querySelector('.container');
  if (mainContainer) mainContainer.style.display = 'none';

  // Decrypt container'ı oluştur
  const decryptContainer = document.createElement('main');
  decryptContainer.className = 'container';
  decryptContainer.id = 'decrypt-container';
  decryptContainer.innerHTML = `
    <section class="step active">
      <div class="glass-card">
        <div class="success-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <h2 class="text-center mb-1">${t('decryptTitle')}</h2>
        <p class="text-center text-muted text-sm mb-2">
          <strong>${escapeHtml(metadata.filename)}</strong> (${formatSize(metadata.file_size)})<br>
          ${t('decryptDesc')}
        </p>

        <div class="form-group">
          <label class="form-label" for="decrypt-password-input">${t('decryptPasswordLabel')}</label>
          <input type="password" id="decrypt-password-input" class="form-input"
                 placeholder="${t('decryptPasswordPlaceholder')}" autocomplete="new-password">
        </div>

        <div id="decrypt-error" class="hidden text-error text-sm text-center mb-1"></div>

        <div class="text-center">
          <button id="decrypt-btn" class="btn btn-primary">
            ${t('decryptBtn')}
          </button>
        </div>

        <div id="decrypt-progress" class="hidden mt-2">
          <div class="progress-bar">
            <div class="progress-fill" id="decrypt-progress-fill"></div>
          </div>
          <p class="text-center text-muted text-sm mt-1" id="decrypt-progress-text">${t('decryptProgressDecrypt')}</p>
        </div>
      </div>
    </section>
  `;

  document.body.appendChild(decryptContainer);

  // Event listeners
  const decryptBtn = document.getElementById('decrypt-btn');
  const passwordInput = document.getElementById('decrypt-password-input');
  const decryptError = document.getElementById('decrypt-error');
  const decryptProgress = document.getElementById('decrypt-progress');
  const decryptProgressFill = document.getElementById('decrypt-progress-fill');
  const decryptProgressText = document.getElementById('decrypt-progress-text');

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') decryptBtn.click();
  });

  decryptBtn.addEventListener('click', async () => {
    const password = passwordInput.value;
    if (!password) {
      decryptError.textContent = t('decryptErrorEmpty');
      decryptError.classList.remove('hidden');
      return;
    }

    decryptBtn.disabled = true;
    decryptError.classList.add('hidden');
    decryptProgress.classList.remove('hidden');
    decryptProgressFill.style.width = '10%';
    decryptProgressText.textContent = t('decryptProgressDownload');

    try {
      // Şifreli dosyayı indir
      const downloadUrl = `/api/files/${fileId}/dl`;
      decryptProgressFill.style.width = '30%';
      decryptProgressText.textContent = t('decryptProgressDownload');

      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(t('decryptErrorDownload'));
      }

      const ciphertext = await resp.arrayBuffer();
      decryptProgressFill.style.width = '60%';
      decryptProgressText.textContent = t('decryptProgressDecrypt');

      // Deşifrele
      const plaintext = await decryptFile(
        ciphertext,
        metadata.encryption_iv,
        metadata.encryption_salt,
        password
      );

      decryptProgressFill.style.width = '100%';
      decryptProgressText.textContent = t('decryptProgressReady');

      // Blob oluştur ve indir
      const blob = new Blob([plaintext], { type: metadata.mime_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Başarılı mesajı
      decryptProgressText.textContent = t('decryptSuccess');
      decryptBtn.textContent = t('decryptDownloaded');
      setTimeout(() => {
        decryptBtn.textContent = t('decryptBtn');
        decryptBtn.disabled = false;
        decryptProgress.classList.add('hidden');
      }, 3000);

    } catch (err) {
      console.error('[Decrypt] Error:', err);
      decryptError.textContent = err.message || t('decryptErrorWrong');
      decryptError.classList.remove('hidden');
      decryptProgress.classList.add('hidden');
      decryptBtn.disabled = false;
    }
  });

  // Focus password input
  setTimeout(() => passwordInput.focus(), 100);
}

// =========================================================================
// Config Yükleme (sayfa açılışında)
// =========================================================================

async function loadConfig() {
  try {
    // Admin ayarlarını config'den al (max dosya boyutu, chunk boyutu, expire ayarları)
    const resp = await fetch('/api/admin/config');
    if (resp.ok) {
      const data = await resp.json();
      if (data.config) {
        const cfg = data.config;

        // --- Maksimum dosya boyutu (bilgi metni + proaktif kontrol) ---
        if (cfg.max_file_size_mb) {
          configMaxFileSizeMB = parseInt(cfg.max_file_size_mb) || 0;
          DOM.maxSizeText.textContent = currentLang === 'en'
            ? `Maximum file size: ${cfg.max_file_size_mb} MB`
            : `Maksimum dosya boyutu: ${cfg.max_file_size_mb} MB`;
        }

        // --- Chunk boyutu (chunked upload için) ---
        if (cfg.chunk_size_mb) {
          chunkSizeBytes = parseInt(cfg.chunk_size_mb) * 1024 * 1024;
        }

        // --- İzin verilen MIME türleri (proaktif kontrol için) ---
        if (cfg.allowed_mime_types) {
          configAllowedMimeTypes = cfg.allowed_mime_types;
        }

        // --- Expire ayarları (dropdown'ı dinamik yapılandır) ---
        // default_expire_hours → dropdown'ın varsayılan seçili option'ı
        // max_expire_hours → bu değerden büyük seçenekleri dropdown'dan gizle
        applyExpireConfig(cfg.default_expire_hours, cfg.max_expire_hours);
      }
    }
  } catch {
    // Config yüklenemezse varsayılan değerle devam et
  }
}

/**
 * Admin'in belirlediği expire ayarlarını expire-select dropdown'ına uygular.
 *  - default_expire_hours: dropdown'ın varsayılan seçili option'ı (admin 24 yaparsa
 *    kullanıcı 24 saat seçili görür; admin–user tutarlılığı).
 *  - max_expire_hours: bu sınırın üstündeki seçenekleri gizler (kullanıcı önceden
 *    bilmeden backend hatası almasın).
 * HTML'deki 5 seçenek (1/6/12/24/48) sabittir; burada sadece selected + gizleme
 * ayarlanır. Mevcut seçili değer gizlenmek zorunda kalırsa, izinli en büyük değere
 * düşürülür.
 */
function applyExpireConfig(defaultExpireHours, maxExpireHours) {
  const select = DOM.expireSelect;
  if (!select) return;

  const maxExpire = maxExpireHours ? parseInt(maxExpireHours) : 48;
  configMaxExpireHours = maxExpire;

  // 1) max_expire_hours sınırının üstündeki seçenekleri gizle
  let bestAllowedValue = null;
  for (const option of select.options) {
    const val = parseInt(option.value);
    const allowed = val <= maxExpire;
    option.hidden = !allowed;
    if (allowed && (bestAllowedValue === null || val > bestAllowedValue)) {
      bestAllowedValue = val;
    }
  }

  // 2) Varsayılan seçili option'ı admin'in default_expire_hours değerine ayarla
  let targetValue = defaultExpireHours ? parseInt(defaultExpireHours) : null;

  // Admin'in default'u max sınırını aşıyorsa (tutarsız ayar), izinli en büyük değere düş
  if (targetValue !== null && targetValue > maxExpire) {
    targetValue = bestAllowedValue;
  }

  if (targetValue !== null) {
    // Eşleşen tam option var mı?
    let matched = null;
    for (const option of select.options) {
      if (parseInt(option.value) === targetValue && !option.hidden) {
        matched = option;
        break;
      }
    }

    if (matched) {
      select.value = String(targetValue);
    } else {
      // Admin'in default'u dropdown'daki sabit seçeneklerden birine denk gelmiyorsa
      // (örn. 8 saat), ondan küçük/büyük en yakın izinli seçeneğe snap'le.
      const snap = findClosestExpireOption(select, targetValue, maxExpire);
      if (snap) select.value = snap.value;
    }
  }
}

/**
 * Verilen hedef saate en yakın (izili) expire option'ını bulur.
 */
function findClosestExpireOption(select, targetValue, maxExpire) {
  let best = null;
  let bestDiff = Infinity;
  for (const option of select.options) {
    if (option.hidden) continue;
    const val = parseInt(option.value);
    if (val > maxExpire) continue;
    const diff = Math.abs(val - targetValue);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = option;
    }
  }
  return best;
}

// =========================================================================
// HTML Escape
// =========================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// =========================================================================
// Dark/Light Mode Toggle (Faz 5.2)
// =========================================================================

function initThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle');
  if (!toggleBtn) return;

  const darkIcon = toggleBtn.querySelector('.icon-theme-dark');
  const lightIcon = toggleBtn.querySelector('.icon-theme-light');

  function setTheme(isLight) {
    if (isLight) {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('filesfly_theme', 'light');
      if (darkIcon) darkIcon.style.display = 'none';
      if (lightIcon) lightIcon.style.display = '';
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('filesfly_theme', 'dark');
      if (darkIcon) darkIcon.style.display = '';
      if (lightIcon) lightIcon.style.display = 'none';
    }
  }

  // localStorage'dan tercihi oku
  const saved = localStorage.getItem('filesfly_theme');
  if (saved === 'light') setTheme(true);

  toggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current !== 'light');
  });
}

// =========================================================================
// i18n (Faz 5.3) — Türkçe + İngilizce
// =========================================================================

// I18N translations ayrı dosyaya taşındı: /js/i18n.js
// (app.js'den önce yüklenmeli — HTML'de script sırasına dikkat)
// I18N object'i global scope'ta, t() fonksiyonu aşağıda kullanır.
// currentLang yukarıda State bölümünde tanımlı (localStorage'dan okunur).

function t(key) {
  return I18N[currentLang]?.[key] || I18N.tr[key] || key;
}

function applyTranslations() {
  // <html lang> attribute güncelle
  document.documentElement.lang = currentLang;

  // data-i18n attribute'ları
  // ÖNEMLİ: SVG ikon içeren elementlerde (örn. nav-link-files) textContent
  // kullanmak SVG'yi siler. Bu yüzden önce SVG çocuu var mı kontrol et —
  // varsa sadece metin düğümünü/span'ı güncelle, SVG'yi koru.
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const text = t(key);
    if (!text) return;

    const svgChild = el.querySelector('svg');
    if (svgChild) {
      // SVG var → SVG'den sonraki metni güncelle (SVG'yi koru)
      // Mevcut text node/span bul: SVG'den sonra gelen ilk text node veya span
      let textNode = null;
      let sibling = svgChild.nextSibling;
      while (sibling) {
        if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) {
          textNode = sibling;
          break;
        }
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'SPAN') {
          textNode = sibling;
          break;
        }
        sibling = sibling.nextSibling;
      }
      if (textNode) {
        if (textNode.nodeType === Node.TEXT_NODE) {
          textNode.textContent = ' ' + text;
        } else {
          textNode.textContent = text;
        }
      } else {
        // SVG'den sonra metin yok → yeni text node ekle
        el.appendChild(document.createTextNode(' ' + text));
      }
    } else {
      // SVG yok → normal textContent güncelleme
      el.textContent = text;
    }
  });

  // data-i18n-placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const text = t(key);
    if (text) el.placeholder = text;
  });

  // data-i18n-title (tooltip/title attribute çevirisi)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const text = t(key);
    if (text) el.title = text;
  });

  // data-i18n-aria (aria-label attribute çevirisi)
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria;
    const text = t(key);
    if (text) el.setAttribute('aria-label', text);
  });

  // Lang switcher butonları
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
}

function initLangSwitcher() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentLang = btn.dataset.lang;
      localStorage.setItem('filesfly_lang', currentLang);
      applyTranslations();
      // Update dynamic elements
      updateDynamicTranslations();
    });
  });
}

function updateDynamicTranslations() {
  // Max size text — configMaxFileSizeMB bilinirsa onu kullan, yoksa mevcut metinden sayıyı çek
  if (DOM.maxSizeText) {
    const mb = configMaxFileSizeMB || (DOM.maxSizeText.textContent.match(/\d+/) || [])[0];
    if (mb) {
      DOM.maxSizeText.textContent = currentLang === 'tr'
        ? `Maksimum dosya boyutu: ${mb} MB`
        : `Maximum file size: ${mb} MB`;
    }
  }

  // Uploading step
  if (currentStep === 'uploading') {
    const cancelBtn = document.getElementById('cancel-upload-btn');
    if (cancelBtn) cancelBtn.textContent = t('cancelUpload');
  }

  // Session page: reload file list so dynamically rendered items get translated
  // (file items, countdown text, download buttons use t() at render time)
  if (typeof loadFiles === 'function' && document.getElementById('file-list')) {
    loadFiles();
  }

  // Success step copy buttons
  // "Kopyalandı!" durumunu data-copied attribute ile takip et (emoji karşılaştırma yerine).
  document.querySelectorAll('[data-copy]').forEach(btn => {
    if (btn.dataset.copied === '1') {
      btn.textContent = t('copied');
    } else {
      btn.textContent = t('copyBtn');
    }
  });
}

// =========================================================================
// E-posta ile Paylaş (Faz 5.5)
// =========================================================================

function updateEmailShareLink(directUrl, filename) {
  const emailLink = document.getElementById('email-share-link');
  if (!emailLink) return;

  const subject = encodeURIComponent(currentLang === 'tr'
    ? `Dosya paylaşımı: ${filename}`
    : `File shared: ${filename}`);
  const body = encodeURIComponent(currentLang === 'tr'
    ? `Merhaba,\n\n${filename} dosyasını seninle paylaşıyorum:\n${directUrl}\n\nDosya belirli bir süre sonra otomatik silinecektir.\n\nFiles Fly ile gönderildi.`
    : `Hi,\n\nI'm sharing "${filename}" with you:\n${directUrl}\n\nThe file will be automatically deleted after a set time.\n\nSent via Files Fly.`);

  emailLink.href = `mailto:?subject=${subject}&body=${body}`;
}

// =========================================================================
// Canlı Countdown + İndirme Sayacı (Faz 5.6)
// =========================================================================

let countdownInterval = null;
let downloadPollInterval = null;

function startLiveCountdown(expireAt) {
  // Eski interval'ı temizle
  if (countdownInterval) clearInterval(countdownInterval);

  const expiryEl = document.getElementById('expiry-time');
  if (!expiryEl) return;

  function update() {
    const now = new Date();
    const expire = new Date(expireAt);
    const diffMs = expire - now;

    if (diffMs <= 0) {
      expiryEl.textContent = currentLang === 'tr' ? 'Süresi doldu' : 'Expired';
      expiryEl.style.color = 'var(--color-error)';
      if (countdownInterval) clearInterval(countdownInterval);
      return;
    }

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

    if (hours > 0) {
      expiryEl.textContent = `${hours}s ${minutes}dk ${seconds}sn`;
    } else if (minutes > 0) {
      expiryEl.textContent = `${minutes}dk ${seconds}sn`;
    } else {
      expiryEl.textContent = `${seconds}sn`;
    }
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

function startDownloadCounter(fileId) {
  // Eski interval'ı temizle
  if (downloadPollInterval) clearInterval(downloadPollInterval);

  const countInfo = document.getElementById('download-count-info');
  const countValue = document.getElementById('download-count-value');
  if (!countInfo || !countValue) return;

  countInfo.classList.remove('hidden');

  async function poll() {
    try {
      const resp = await fetch(`/api/files/${fileId}`);
      if (resp.ok) {
        const data = await resp.json();
        countValue.textContent = data.download_count || 0;
      }
    } catch {
      // ignore poll errors
    }
  }

  poll();
  downloadPollInterval = setInterval(poll, 10000); // Her 10 saniyede bir
}

// =========================================================================
// Başlat
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();

  // Lucide icons'ları başlat (CDN'den yüklendiyse)
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }

  // Theme toggle
  initThemeToggle();

  // i18n
  applyTranslations();
  initLangSwitcher();

  // Parola korumalı dosya decrypt modu kontrolü
  checkDecryptMode();

  // Batch tray geri yükle (localStorage) — completed/partial kartlar read-only
  restoreBatches();

  // Service Worker registration (PWA) — disabled until OOM resolved
  // if ('serviceWorker' in navigator) {
  //   navigator.serviceWorker.register('/sw.js').catch(() => {});
  // }
});
