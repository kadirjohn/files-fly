/**
 * app.js — Files Fly Ana Sayfa JavaScript
 * 
 * Özellikler:
 * - Drag & drop + dosya seçme
 * - Dosya thumbnail önizleme
 * - Parola koruma opsiyonu
 * - XHR upload + progress (hız/ETA)
 * - Yükleme iptal
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
let xhr = null;           // Aktif XHR (iptal için)
let uploadStartTime = 0;
let lastLoaded = 0;
let lastTime = 0;
let currentStep = 'select';

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
function handleFileSelect(file) {
  selectedFile = file;

  // Dosya adı ve boyut
  DOM.previewName.textContent = file.name;
  DOM.previewSize.textContent = formatSize(file.size);

  // İkon (resim ise thumbnail)
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      DOM.previewIcon.innerHTML = `<img src="${e.target.result}" alt="preview" style="width:48px;height:48px;object-fit:cover;border-radius:8px;">`;
    };
    reader.readAsDataURL(file.slice(0, 1024 * 100)); // İlk 100KB thumbnail için
  } else {
    DOM.previewIcon.textContent = getFileIcon(file.type, file.name);
  }

  // Preview'ı göster
  DOM.filePreview.classList.remove('hidden');
  DOM.uploadBtn.disabled = false;
}

// Dosyayı kaldır
DOM.clearFileBtn.addEventListener('click', () => {
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
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return '📦';
  if (mimeType.includes('text') || mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml')) return '📝';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📄';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
  return '📄';
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
// Yükleme
// =========================================================================

DOM.uploadBtn.addEventListener('click', startUpload);

function startUpload() {
  if (!selectedFile) return;

  // Session cookie kontrolü — yoksa önce session oluştur
  ensureSession().then(() => {
    doUpload();
  }).catch(err => {
    showToast('Oturum oluşturulamadı. Lütfen sayfayı yenileyin.', 'error');
  });
}

async function ensureSession() {
  // Cookie'de session var mı?
  if (getCookie('filesfly_sid')) return;

  // POST /api/session
  const resp = await fetch('/api/session', { method: 'POST' });
  if (!resp.ok) throw new Error('Session creation failed');
}

function doUpload() {
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
  formData.append('file', selectedFile);
  formData.append('expire', DOM.expireSelect.value);

  if (DOM.passwordToggle.checked && DOM.passwordInput.value) {
    formData.append('password', DOM.passwordInput.value);
  }

  // XHR ile upload (progress takibi için)
  xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      updateProgress(e.loaded, e.total);
    }
  });

  xhr.addEventListener('load', () => {
    xhr = null;
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const result = JSON.parse(xhr.responseText);
        handleUploadSuccess(result);
      } catch {
        handleUploadError('Sunucu yanıtı işlenemedi.');
      }
    } else {
      try {
        const err = JSON.parse(xhr.responseText);
        handleUploadError(err.error || `Hata: ${xhr.status}`);
      } catch {
        handleUploadError(`Sunucu hatası: ${xhr.status}`);
      }
    }
  });

  xhr.addEventListener('error', () => {
    xhr = null;
    handleUploadError('Bağlantı hatası. Lütfen internet bağlantınızı kontrol edin.');
  });

  xhr.addEventListener('abort', () => {
    xhr = null;
    showStep('select');
    showToast('Yükleme iptal edildi.', 'info');
  });

  xhr.open('POST', '/api/upload');
  uploadStartTime = Date.now();
  lastLoaded = 0;
  lastTime = uploadStartTime;
  xhr.send(formData);
}

// Progress güncelleme
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

// İptal
DOM.cancelUploadBtn.addEventListener('click', () => {
  if (xhr) {
    xhr.abort();
  }
});

// =========================================================================
// Başarılı Yükleme
// =========================================================================

function handleUploadSuccess(result) {
  showStep('success');

  // Linkleri göster
  DOM.directLinkUrl.textContent = result.direct_url;
  DOM.previewLinkUrl.textContent = result.preview_url;

  // Süre bilgisi
  const expireDate = new Date(result.expire_at);
  const hoursLeft = Math.round((expireDate - new Date()) / (1000 * 60 * 60));
  DOM.expiryTime.textContent = `${hoursLeft} saat`;

  // QR Kod
  generateQR(result.direct_url);

  // Parola bilgisi
  if (result.is_encrypted) {
    DOM.passwordInfo.classList.remove('hidden');
  } else {
    DOM.passwordInfo.classList.add('hidden');
  }

  // Link kopyalama butonları
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copy;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        copyToClipboard(targetEl.textContent);
        btn.textContent = '✅ Kopyalandı!';
        setTimeout(() => { btn.textContent = '📋 Kopyala'; }, 2000);
      }
    });
  });
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
  selectedFile = null;
  DOM.fileInput.value = '';
  DOM.filePreview.classList.add('hidden');
  DOM.uploadBtn.disabled = true;
  DOM.passwordToggle.checked = false;
  DOM.passwordField.classList.add('hidden');
  DOM.passwordInput.value = '';
  showStep('select');
}

// =========================================================================
// Clipboard
// =========================================================================

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Link kopyalandı!', 'success');
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
    showToast('Link kopyalandı!', 'success');
  } catch {
    showToast('Kopyalanamadı. Lütfen manuel kopyalayın.', 'error');
  }
  document.body.removeChild(textarea);
}

// =========================================================================
// Toast Notification
// =========================================================================

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${message}`;

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
// Config Yükleme (sayfa açılışında)
// =========================================================================

async function loadConfig() {
  try {
    // Maksimum dosya boyutunu config'den al
    const resp = await fetch('/api/admin/config');
    if (resp.ok) {
      const data = await resp.json();
      if (data.config && data.config.max_file_size_mb) {
        DOM.maxSizeText.textContent = `Maksimum dosya boyutu: ${data.config.max_file_size_mb} MB`;
      }
    }
  } catch {
    // Config yüklenemezse varsayılan değerle devam et
  }
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
});
