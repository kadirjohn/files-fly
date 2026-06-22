/**
 * app.js — Files Fly Ana Sayfa JavaScript
 *
 * Özellikler:
 * - Drag & drop + dosya seçme
 * - Dosya thumbnail önizleme
 * - Parola koruma opsiyonu (AES-GCM — Faz 4.3)
 * - Tek seferde upload (küçük dosyalar) + Chunked upload (büyük dosyalar)
 * - Chunked: dosya bölme, sıralı fetch, progress, resume desteği
 * - Yükleme iptal (AbortController)
 * - Başarılı: link kopyalama, QR kod
 * - Toast notification
 * - Retry mekanizması
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

  // Step 1 — Select
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  expireSelect: document.getElementById('expire-select'),
  maxSizeText: document.getElementById('max-size-text'),
  filePreview: document.getElementById('file-preview'),
  previewIcon: document.getElementById('preview-icon'),
  previewName: document.getElementById('preview-name'),
  previewSize: document.getElementById('preview-size'),
  clearFileBtn: document.getElementById('clear-file-btn'),
  passwordToggle: document.getElementById('password-toggle'),
  passwordField: document.getElementById('password-field'),
  passwordInput: document.getElementById('password-input'),
  uploadBtn: document.getElementById('upload-btn'),

  // Step 2 — Uploading
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
// State
// =========================================================================

let selectedFile = null;
let xhr = null;              // Aktif XHR (tek seferde upload için)
let abortController = null;  // Aktif AbortController (chunked upload için)
let uploadStartTime = 0;
let lastLoaded = 0;
let lastTime = 0;
let currentStep = 'select';

// Chunked upload state
let chunkedMode = false;
let fileId = null;
let chunkSizeBytes = 5 * 1024 * 1024; // Varsayılan 5MB, config'den güncellenir
let totalChunks = 0;
let uploadedChunks = 0;
let chunkBytesUploaded = 0;

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
// Dosya Seçimi
// =========================================================================

// Drop zone click → file input
DOM.dropZone.addEventListener('click', () => {
  DOM.fileInput.click();
});

// File input change
DOM.fileInput.addEventListener('change', () => {
  if (DOM.fileInput.files.length > 0) {
    handleFileSelect(DOM.fileInput.files[0]);
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
    handleFileSelect(e.dataTransfer.files[0]);
  }
});

// Dosya seçildiğinde
// Seçilen dosya için object URL (preview amaçlı, bellek sızıntısını önlemek için takip edilir)
let selectedFileObjectURL = null;

function handleFileSelect(file) {
  selectedFile = file;

  // Eski object URL'i temizle (bellek sızıntısı önle)
  if (selectedFileObjectURL) {
    URL.revokeObjectURL(selectedFileObjectURL);
    selectedFileObjectURL = null;
  }

  // Dosya adı ve boyut
  DOM.previewName.textContent = file.name;
  DOM.previewSize.textContent = formatSize(file.size);

  // İkon (resim ise gerçek thumbnail — URL.createObjectURL ile, base64/truncation yok)
  if (file.type.startsWith('image/')) {
    selectedFileObjectURL = URL.createObjectURL(file);
    DOM.previewIcon.innerHTML = `<img src="${selectedFileObjectURL}" alt="${escapeHtml(file.name)}" class="preview-thumb">`;
  } else {
    DOM.previewIcon.textContent = getFileIcon(file.type, file.name);
  }

  // Preview'ı göster
  DOM.filePreview.classList.remove('hidden');
  DOM.uploadBtn.disabled = false;
}

// Dosyayı kaldır
DOM.clearFileBtn.addEventListener('click', () => {
  // Object URL'i serbest bırak
  if (selectedFileObjectURL) {
    URL.revokeObjectURL(selectedFileObjectURL);
    selectedFileObjectURL = null;
  }
  selectedFile = null;
  DOM.fileInput.value = '';
  DOM.filePreview.classList.add('hidden');
  DOM.uploadBtn.disabled = true;
});

// Parola toggle
DOM.passwordToggle.addEventListener('change', () => {
  if (DOM.passwordToggle.checked) {
    DOM.passwordField.classList.remove('hidden');
    DOM.passwordInput.focus();
  } else {
    DOM.passwordField.classList.add('hidden');
    DOM.passwordInput.value = '';
  }
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
// Yükleme Başlatma
// =========================================================================

DOM.uploadBtn.addEventListener('click', startUpload);

async function startUpload() {
  if (!selectedFile) return;

  dbg.group('upload', `Upload starting: ${selectedFile.name}`, {
    name: selectedFile.name,
    size: selectedFile.size,
    sizeFormatted: formatSize(selectedFile.size),
    type: selectedFile.type,
  });

  // Session cookie kontrolü — yoksa önce session oluştur
  try {
    await ensureSession();
  } catch (err) {
    dbg.error('session', 'Session creation failed', err);
    showToast(t('sessionError'), 'error');
    return;
  }

  // Parola koruması varsa önce şifrele
  const password = DOM.passwordToggle.checked ? DOM.passwordInput.value : null;
  let fileToUpload = selectedFile;
  let encryptionIV = null;
  let encryptionSalt = null;
  let originalMimeType = selectedFile.type || 'application/octet-stream';

  if (password && password.length > 0) {
    try {
      dbg.info('encrypt', 'Encrypting file (AES-256-GCM)', { passwordLen: password.length });
      showToast(t('encrypting'), 'info');
      const encrypted = await encryptFile(selectedFile, password);
      fileToUpload = encrypted.ciphertext;
      encryptionIV = encrypted.iv;
      encryptionSalt = encrypted.salt;
      originalMimeType = selectedFile.type || 'application/octet-stream';
      dbg.info('encrypt', '✓ Encryption complete', { encryptedSize: fileToUpload.size });
      showToast(t('encrypted'), 'success');
    } catch (err) {
      dbg.error('encrypt', 'Encryption error', err);
      console.error('[Crypto] Encryption error:', err);
      showToast(t('encryptError'), 'error');
      return;
    }
  }

  // Dosya boyutuna göre tek seferde veya chunked upload
  const chunkSize = chunkSizeBytes || (5 * 1024 * 1024);
  if (fileToUpload.size <= chunkSize) {
    dbg.info('upload', 'Mode: Single upload (small file)', { size: fileToUpload.size, threshold: chunkSize });
    chunkedMode = false;
    doSingleUpload(fileToUpload, password, encryptionIV, encryptionSalt, originalMimeType);
  } else {
    dbg.info('upload', 'Mode: Chunked upload (large file)', { size: fileToUpload.size, threshold: chunkSize });
    chunkedMode = true;
    doChunkedUpload(fileToUpload, password, encryptionIV, encryptionSalt, originalMimeType);
  }
}

async function ensureSession() {
  // Cookie'de session var mı?
  if (getCookie('filesfly_sid')) {
    dbg.log('session', 'Session cookie present, no need to create new session');
    return;
  }

  dbg.info('session', 'No session, POST /api/session creating...');
  // POST /api/session
  const resp = await fetch('/api/session', { method: 'POST' });
  if (!resp.ok) {
    dbg.error('session', 'Session creation failed', { status: resp.status });
    throw new Error('Session creation failed');
  }
  dbg.info('session', '✓ Session created (cookie set)');
}

// =========================================================================
// Tek Seferde Upload (Küçük Dosyalar — XHR)
// =========================================================================

function doSingleUpload(fileToUpload, password, encryptionIV, encryptionSalt, originalMimeType) {
  showStep('uploading');

  // Uploading step bilgileri
  DOM.uploadingIcon.textContent = getFileIcon(selectedFile.type, selectedFile.name);
  DOM.uploadingName.textContent = selectedFile.name;
  DOM.uploadingSize.textContent = formatSize(selectedFile.size);

  // Progress sıfırla
  DOM.progressFill.style.width = '0%';
  DOM.progressPercent.textContent = '%0';
  DOM.progressSpeed.textContent = '';
  DOM.progressEta.textContent = '';

  // FormData hazırla
  const formData = new FormData();
  formData.append('file', fileToUpload, selectedFile.name);
  formData.append('expire', DOM.expireSelect.value);

  if (password) {
    formData.append('password', password);
    formData.append('encryption_iv', encryptionIV);
    formData.append('encryption_salt', encryptionSalt);
    formData.append('mime_type', originalMimeType);
  }

  dbg.info('upload', 'XHR POST /api/upload starting', {
    fileName: selectedFile.name,
    size: fileToUpload.size,
    encrypted: !!password,
    expire: DOM.expireSelect.value,
  });

  // XHR ile upload (progress takibi için)
  xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      updateProgress(e.loaded, e.total);
      // Her %25'de bir debug log (spam önle)
      const pct = Math.round((e.loaded / e.total) * 100);
      if (pct % 25 === 0) dbg.log('upload', `Progress: ${pct}%`, { loaded: e.loaded, total: e.total });
    }
  });

  xhr.addEventListener('load', () => {
    const status = xhr.status;
    const responseText = xhr.responseText;
    xhr = null;
    dbg.info('upload', `XHR response: HTTP ${status}`, { responseLen: responseText.length });
    if (status >= 200 && status < 300) {
      try {
        const result = JSON.parse(responseText);
        handleUploadSuccess(result);
      } catch {
        dbg.error('upload', 'Response JSON parse failed', responseText.substring(0, 200));
        handleUploadError(t('serverResponseError'));
      }
    } else {
      try {
        const err = JSON.parse(responseText);
        dbg.error('upload', 'Server error', { status, error: err.error });
        handleUploadError(err.error || `Hata: ${status}`);
      } catch {
        dbg.error('upload', 'Server error (non-JSON)', { status, body: responseText.substring(0, 200) });
        handleUploadError(`Sunucu hatası: ${status}`);
      }
    }
  });

  xhr.addEventListener('error', () => {
    xhr = null;
    dbg.error('upload', 'XHR network error (connection error)');
    handleUploadError(t('connectionError'));
  });

  xhr.addEventListener('abort', () => {
    xhr = null;
    dbg.warn('upload', 'XHR aborted (user)');
    showStep('select');
    showToast(t('uploadCancelled'), 'info');
  });

  xhr.open('POST', '/api/upload');
  uploadStartTime = Date.now();
  lastLoaded = 0;
  lastTime = uploadStartTime;
  dbg.time('upload', 'XHR upload');
  xhr.send(formData);
}

// =========================================================================
// Chunked Upload (Büyük Dosyalar — Fetch API)
// =========================================================================

async function doChunkedUpload(fileToUpload, password, encryptionIV, encryptionSalt, originalMimeType) {
  showStep('uploading');

  // Uploading step bilgileri
  DOM.uploadingIcon.textContent = getFileIcon(selectedFile.type, selectedFile.name);
  DOM.uploadingName.textContent = selectedFile.name;
  DOM.uploadingSize.textContent = formatSize(selectedFile.size);

  // Progress sıfırla
  DOM.progressFill.style.width = '0%';
  DOM.progressPercent.textContent = '%0';
  DOM.progressSpeed.textContent = '';
  DOM.progressEta.textContent = '';

  // Chunk state
  fileId = generateUUID();
  totalChunks = Math.ceil(fileToUpload.size / chunkSizeBytes);
  uploadedChunks = 0;
  chunkBytesUploaded = 0;
  abortController = new AbortController();
  uploadStartTime = Date.now();
  lastLoaded = 0;
  lastTime = uploadStartTime;

  dbg.info('chunk', 'Chunked upload initializing', {
    fileId,
    totalChunks,
    chunkSize: chunkSizeBytes,
    totalSize: fileToUpload.size,
  });

  // -----------------------------------------------------------------------
  // Resume kontrolü: daha önce başlanmış upload var mı?
  // -----------------------------------------------------------------------
  try {
    dbg.log('chunk', `Resume check: GET /api/upload/chunk/${fileId}/status`);
    const statusResp = await fetch(`/api/upload/chunk/${fileId}/status`, {
      signal: abortController.signal,
    });
    if (statusResp.ok) {
      const status = await statusResp.json();
      if (status.exists && status.received_chunks > 0) {
        // Kaldığı yerden devam et
        uploadedChunks = status.received_chunks;
        dbg.info('chunk', `Resume: ${uploadedChunks}/${totalChunks} chunks already uploaded, resuming`);
        // Alınmış chunk'ların toplam boyutunu hesapla
        const lastChunkIndex = uploadedChunks - 1;
        const fullChunkSize = chunkSizeBytes;
        chunkBytesUploaded = lastChunkIndex < totalChunks - 1
          ? uploadedChunks * fullChunkSize
          : Math.min(uploadedChunks * fullChunkSize, fileToUpload.size);
        updateChunkProgress(chunkBytesUploaded, fileToUpload.size);
        showToast(`${uploadedChunks}/${totalChunks} ${t('chunkResume')}`, 'info');
      } else {
        dbg.log('chunk', 'Resume: no previous upload, starting fresh');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      dbg.warn('chunk', 'Resume check aborted');
      return;
    }
    dbg.warn('chunk', 'Resume status fetch failed, starting fresh', err.message);
  }

  // -----------------------------------------------------------------------
  // Chunk'ları sırayla gönder
  // -----------------------------------------------------------------------
  dbg.group('chunk', `Chunk loop: ${uploadedChunks} → ${totalChunks}`);
  for (let i = uploadedChunks; i < totalChunks; i++) {
    if (abortController.signal.aborted) {
      dbg.warn('chunk', `Loop aborted (chunk ${i})`);
      break;
    }

    const start = i * chunkSizeBytes;
    const end = Math.min(start + chunkSizeBytes, fileToUpload.size);
    const chunk = fileToUpload.slice(start, end);

    dbg.log('chunk', `Chunk ${i + 1}/${totalChunks} sending`, { size: chunk.size });
    const success = await uploadChunk(i, chunk, password, encryptionIV, encryptionSalt, originalMimeType);
    if (!success) {
      dbg.error('chunk', `Chunk ${i + 1}/${totalChunks} failed, upload stopped`);
      dbg.groupEnd('chunk');
      return; // Hata oluştu, handleUploadError zaten çağrıldı
    }

    uploadedChunks++;
    chunkBytesUploaded += chunk.size;
    updateChunkProgress(chunkBytesUploaded, fileToUpload.size);
    dbg.log('chunk', `✓ Chunk ${i + 1}/${totalChunks} complete (${Math.round((uploadedChunks / totalChunks) * 100)}%)`);
  }
  dbg.groupEnd('chunk');

  // abortController, son chunk tamamlandığında uploadChunk içinde null'a set edilir.
  // Bu yüzden null check yapmadan .signal'e erişemeyiz (TypeError: null.signal).
  if (abortController && abortController.signal.aborted) return;

  // Tüm chunk'lar gönderildi — son chunk'ın response'u zaten complete:true döndü
  // handleUploadSuccess son chunk'ta çağrıldı
  dbg.info('chunk', 'Chunked upload loop done — handleUploadSuccess called on last chunk');
}

/**
 * Tek bir chunk'ı fetch ile gönderir.
 * @param {number} chunkIndex
 * @param {Blob} chunk
 * @param {string|null} password
 * @param {string|null} encryptionIV
 * @param {string|null} encryptionSalt
 * @param {string|null} originalMimeType
 * @returns {Promise<boolean>} - Başarılıysa true
 */
async function uploadChunk(chunkIndex, chunk, password, encryptionIV, encryptionSalt, originalMimeType) {
  const formData = new FormData();
  formData.append('chunk', chunk, `chunk_${chunkIndex}`);
  formData.append('chunk_index', String(chunkIndex));
  formData.append('total_chunks', String(totalChunks));
  formData.append('file_id', fileId);
  formData.append('filename', selectedFile.name);
  formData.append('expire', DOM.expireSelect.value);

  if (password) {
    formData.append('password', password);
    formData.append('encryption_iv', encryptionIV);
    formData.append('encryption_salt', encryptionSalt);
    formData.append('mime_type', originalMimeType);
  }

  let retries = 0;
  const maxRetries = 3;

  while (retries <= maxRetries) {
    try {
      dbg.log('chunk', `Chunk ${chunkIndex + 1}/${totalChunks} → POST /api/upload/chunk (attempt ${retries + 1})`);
      const resp = await fetch('/api/upload/chunk', {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        dbg.error('chunk', `Chunk ${chunkIndex + 1} HTTP ${resp.status}`, errData);
        handleUploadError(errData.error || `Chunk upload error: ${resp.status}`);
        return false;
      }

      const result = await resp.json();

      if (result.complete) {
        // Son chunk — upload tamamlandı
        dbg.info('chunk', `✓ Last chunk (${chunkIndex + 1}/${totalChunks}) — upload complete!`, { fileId: result.id, directUrl: result.direct_url });
        abortController = null;
        handleUploadSuccess(result);
      }

      return true;
    } catch (err) {
      if (err.name === 'AbortError') {
        dbg.warn('chunk', `Chunk ${chunkIndex + 1} aborted`);
        return false;
      }

      retries++;
      if (retries > maxRetries) {
        dbg.error('chunk', `Chunk ${chunkIndex + 1} failed after ${maxRetries + 1} attempts`, err);
        handleUploadError(`${t('chunkFailed')} (${chunkIndex + 1}/${totalChunks})`);
        return false;
      }

      dbg.warn('chunk', `Chunk ${chunkIndex + 1} error, ${retries}/${maxRetries} retry — waiting ${1000 * retries}ms`, err.message);
      // Retry öncesi kısa bekle
      await new Promise(r => setTimeout(r, 1000 * retries));
    }
  }

  return false;
}

/**
 * Chunked upload için progress güncelleme.
 */
function updateChunkProgress(loaded, total) {
  const percent = Math.round((loaded / total) * 100);
  DOM.progressFill.style.width = `${percent}%`;
  DOM.progressPercent.textContent = `%${percent}`;

  // Hız hesapla
  const now = Date.now();
  const elapsed = (now - lastTime) / 1000;
  if (elapsed > 0.5) {
    const bytesPerSec = (loaded - lastLoaded) / elapsed;
    DOM.progressSpeed.textContent = `${formatSize(bytesPerSec)}/s`;
    lastLoaded = loaded;
    lastTime = now;
  }

  // ETA hesapla
  if (loaded > 0) {
    const totalElapsed = (now - uploadStartTime) / 1000;
    const bytesPerSecAvg = loaded / totalElapsed;
    const remaining = total - loaded;
    if (bytesPerSecAvg > 0) {
      const eta = remaining / bytesPerSecAvg;
      DOM.progressEta.textContent = `${formatTime(eta)} kaldı`;
    }
  }
}

// =========================================================================
// Progress Güncelleme (Tek Seferde Upload)
// =========================================================================

function updateProgress(loaded, total) {
  const percent = Math.round((loaded / total) * 100);
  DOM.progressFill.style.width = `${percent}%`;
  DOM.progressPercent.textContent = `%${percent}`;

  // Hız hesapla
  const now = Date.now();
  const elapsed = (now - lastTime) / 1000; // saniye
  if (elapsed > 0.5) {
    const bytesPerSec = (loaded - lastLoaded) / elapsed;
    DOM.progressSpeed.textContent = `${formatSize(bytesPerSec)}/s`;
    lastLoaded = loaded;
    lastTime = now;
  }

  // ETA hesapla
  if (loaded > 0) {
    const totalElapsed = (now - uploadStartTime) / 1000;
    const bytesPerSecAvg = loaded / totalElapsed;
    const remaining = total - loaded;
    if (bytesPerSecAvg > 0) {
      const eta = remaining / bytesPerSecAvg;
      DOM.progressEta.textContent = `${formatTime(eta)} kaldı`;
    }
  }
}

// =========================================================================
// İptal
// =========================================================================

DOM.cancelUploadBtn.addEventListener('click', () => {
  if (chunkedMode && abortController) {
    abortController.abort();
    abortController = null;
    showStep('select');
    showToast(t('chunkCancelled'), 'info');
  } else if (xhr) {
    xhr.abort();
  }
});

// =========================================================================
// Başarılı Yükleme
// =========================================================================

function handleUploadSuccess(result) {
  dbg.group('upload', '✓ Upload successful!', {
    id: result.id,
    filename: result.filename,
    direct_url: result.direct_url,
    preview_url: result.preview_url,
    is_encrypted: result.is_encrypted,
    expire_at: result.expire_at,
  });
  showStep('success');

  // Linkleri göster — backend relative path döndürür, tam URL olarak göster
  // (ngrok/production'da window.location.origin host'u yakalar)
  const origin = window.location.origin;
  const directFull = result.direct_url.startsWith('http') ? result.direct_url : origin + result.direct_url;
  const previewFull = result.preview_url.startsWith('http') ? result.preview_url : origin + result.preview_url;

  DOM.directLinkUrl.textContent = directFull;
  DOM.previewLinkUrl.textContent = previewFull;

  // Canlı countdown başlat (Faz 5.6)
  startLiveCountdown(result.expire_at);

  // İndirme sayacı (Faz 5.6)
  startDownloadCounter(result.id);

  // QR Kod (tam URL ile — relative path QR'da çalışmaz)
  generateQR(directFull);

  // QR Kopyalama butonu
  const qrCopyBtn = document.getElementById('qr-copy-btn');
  if (qrCopyBtn) {
    qrCopyBtn.addEventListener('click', () => copyQRToClipboard());
  }

  // E-posta paylaşım linki (Faz 5.5)
  updateEmailShareLink(directFull, result.filename);

  // Parola bilgisi
  if (result.is_encrypted) {
    DOM.passwordInfo.classList.remove('hidden');
  } else {
    DOM.passwordInfo.classList.add('hidden');
  }

  // i18n güncelle
  applyTranslations();

  // Link kopyalama butonları
  document.querySelectorAll('[data-copy]').forEach(btn => {
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

// QR Kod oluştur
function generateQR(url) {
  // QRious global olarak CDN'den yüklenmiş olmalı
  if (typeof QRious === 'undefined') {
    DOM.qrCanvas.parentElement.classList.add('hidden');
    return;
  }

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

function handleUploadError(message) {
  dbg.error('upload', '✕ Upload error', message);
  showStep('error');
  DOM.errorMessage.textContent = message;
}

// Retry
DOM.retryBtn.addEventListener('click', () => {
  showStep('select');
  // Dosya hala seçili, tekrar dene
});

// Yeni dosya (error sayfasından)
DOM.newUploadErrorBtn.addEventListener('click', resetToSelect);

// Yeni dosya (success sayfasından)
DOM.newUploadBtn.addEventListener('click', resetToSelect);

function resetToSelect() {
  // Object URL'i serbest bırak (bellek sızıntısı önle)
  if (selectedFileObjectURL) {
    URL.revokeObjectURL(selectedFileObjectURL);
    selectedFileObjectURL = null;
  }
  selectedFile = null;
  fileId = null;
  chunkedMode = false;
  totalChunks = 0;
  uploadedChunks = 0;
  chunkBytesUploaded = 0;
  DOM.fileInput.value = '';
  DOM.filePreview.classList.add('hidden');
  DOM.uploadBtn.disabled = true;
  DOM.passwordToggle.checked = false;
  DOM.passwordField.classList.add('hidden');
  DOM.passwordInput.value = '';
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
    // Maksimum dosya boyutunu ve chunk boyutunu config'den al
    const resp = await fetch('/api/admin/config');
    if (resp.ok) {
      const data = await resp.json();
      if (data.config) {
        if (data.config.max_file_size_mb) {
          DOM.maxSizeText.textContent = `Maksimum dosya boyutu: ${data.config.max_file_size_mb} MB`;
        }
        if (data.config.chunk_size_mb) {
          chunkSizeBytes = parseInt(data.config.chunk_size_mb) * 1024 * 1024;
        }
      }
    }
  } catch {
    // Config yüklenemezse varsayılan değerle devam et
  }
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

let currentLang = localStorage.getItem('filesfly_lang') || 'tr';

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
  // Max size text
  if (DOM.maxSizeText) {
    const mb = DOM.maxSizeText.textContent.match(/\d+/);
    if (mb) {
      DOM.maxSizeText.textContent = currentLang === 'tr'
        ? `Maksimum dosya boyutu: ${mb[0]} MB`
        : `Maximum file size: ${mb[0]} MB`;
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

  // Service Worker registration (PWA) — disabled until OOM resolved
  // if ('serviceWorker' in navigator) {
  //   navigator.serviceWorker.register('/sw.js').catch(() => {});
  // }
});
