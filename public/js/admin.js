/**
 * admin.js — Files Fly Admin Paneli JavaScript
 * 
 * Özellikler:
 * - Login/logout (JWT token yönetimi)
 * - 4 sekmeli panel: Dashboard, Dosyalar, IP Yönetimi, Ayarlar
 * - Dosya listesi (sayfalama, arama, MIME filtre)
 * - Dosya önizleme (text/image/video/PDF)
 * - Dosya silme
 * - IP yasaklama/kaldırma
 * - Sistem ayarları güncelleme
 */

// =========================================================================
// State
// =========================================================================

let token = localStorage.getItem('filesfly_admin_token') || null;
let currentTab = 'dashboard';
let filesPage = 1;
let filesTotalPages = 1;
let previewFileId = null;

// Parola gate state — o anki şifreli dosya için preview metadata
let gateFileMeta = null;
let gateMode = 'preview'; // 'preview' | 'download'
let gateDecryptedBlobUrl = null;

// =========================================================================
// DOM Referansları
// =========================================================================

const DOM = {
  // Login
  loginSection: document.getElementById('login-section'),
  loginUsername: document.getElementById('login-username'),
  loginPassword: document.getElementById('login-password'),
  loginBtn: document.getElementById('login-btn'),
  loginError: document.getElementById('login-error'),

  // Admin
  adminSection: document.getElementById('admin-section'),
  adminUsername: document.getElementById('admin-username'),
  logoutBtn: document.getElementById('logout-btn'),

  // Tabs
  tabs: document.querySelectorAll('.admin-tab'),
  panels: document.querySelectorAll('.admin-panel'),

  // Dashboard
  statsGrid: document.getElementById('stats-grid'),
  dailyStats: document.getElementById('daily-stats'),

  // Files
  filesSearch: document.getElementById('files-search'),
  filesMimeFilter: document.getElementById('files-mime-filter'),
  filesSearchBtn: document.getElementById('files-search-btn'),
  filesTableBody: document.getElementById('files-table-body'),
  filesPrevBtn: document.getElementById('files-prev-btn'),
  filesNextBtn: document.getElementById('files-next-btn'),
  filesPageInfo: document.getElementById('files-page-info'),

  // Preview
  previewPanel: document.getElementById('preview-panel'),
  previewTitle: document.getElementById('preview-title'),
  previewContent: document.getElementById('preview-content'),
  previewCloseBtn: document.getElementById('preview-close-btn'),
  previewDownloadBtn: document.getElementById('preview-download-btn'),
  previewDeleteBtn: document.getElementById('preview-delete-btn'),

  // Parola Gate (şifreli dosyalar)
  adminPasswordGate: document.getElementById('admin-password-gate'),
  adminGateFilename: document.getElementById('admin-gate-filename'),
  adminGatePasswordInput: document.getElementById('admin-gate-password-input'),
  adminGateToggleVisibility: document.getElementById('admin-gate-toggle-visibility'),
  adminGateError: document.getElementById('admin-gate-error'),
  adminGateProgress: document.getElementById('admin-gate-progress'),
  adminGateProgressFill: document.getElementById('admin-gate-progress-fill'),
  adminGateProgressText: document.getElementById('admin-gate-progress-text'),
  adminGatePreviewBtn: document.getElementById('admin-gate-preview-btn'),
  adminGateDownloadBtn: document.getElementById('admin-gate-download-btn'),

  // IPs
  banIpInput: document.getElementById('ban-ip-input'),
  banReasonInput: document.getElementById('ban-reason-input'),
  banDurationSelect: document.getElementById('ban-duration-select'),
  banIpBtn: document.getElementById('ban-ip-btn'),
  banError: document.getElementById('ban-error'),
  bannedIpsList: document.getElementById('banned-ips-list'),

  // Settings
  settingsForm: document.getElementById('settings-form'),
  settingsSaveBtn: document.getElementById('settings-save-btn'),
  settingsSaved: document.getElementById('settings-saved'),
};

// =========================================================================
// Auth
// =========================================================================

// Sayfa yüklendiğinde token kontrolü
if (token) {
  // Token'ı doğrula
  verifyToken().then(valid => {
    if (valid) {
      showAdmin();
    } else {
      token = null;
      localStorage.removeItem('filesfly_admin_token');
      showLogin();
    }
  });
} else {
  showLogin();
}

async function verifyToken() {
  try {
    const resp = await fetch(`/api/admin/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function showLogin() {
  DOM.loginSection.classList.remove('hidden');
  DOM.adminSection.classList.add('hidden');
  DOM.logoutBtn.classList.add('hidden');
}

function showAdmin() {
  DOM.loginSection.classList.add('hidden');
  DOM.adminSection.classList.remove('hidden');
  DOM.logoutBtn.classList.remove('hidden');

  // Token'dan username çıkar
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    DOM.adminUsername.innerHTML = `${iconSvg} ${escapeHtml(payload.sub)}`;
  } catch {
    DOM.adminUsername.textContent = '';
  }

  loadDashboard();
}

// Login
DOM.loginBtn.addEventListener('click', async () => {
  const username = DOM.loginUsername.value.trim();
  const password = DOM.loginPassword.value;

  if (!username || !password) {
    DOM.loginError.textContent = 'Kullanıcı adı ve parola gerekli.';
    DOM.loginError.classList.remove('hidden');
    return;
  }

  DOM.loginBtn.disabled = true;
  DOM.loginError.classList.add('hidden');

  try {
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      DOM.loginError.textContent = data.error || 'Giriş başarısız.';
      DOM.loginError.classList.remove('hidden');
      return;
    }

    token = data.token;
    localStorage.setItem('filesfly_admin_token', token);
    showAdmin();
  } catch (err) {
    DOM.loginError.textContent = 'Bağlantı hatası.';
    DOM.loginError.classList.remove('hidden');
  } finally {
    DOM.loginBtn.disabled = false;
  }
});

// Enter ile login
DOM.loginPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') DOM.loginBtn.click();
});

// Logout
DOM.logoutBtn.addEventListener('click', () => {
  token = null;
  localStorage.removeItem('filesfly_admin_token');
  showLogin();
  DOM.loginUsername.value = '';
  DOM.loginPassword.value = '';
});

// =========================================================================
// Tab Yönetimi
// =========================================================================

DOM.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    currentTab = tab.dataset.tab;

    // Aktif tab
    DOM.tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Aktif panel
    DOM.panels.forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${currentTab}`).classList.add('active');

    // Panel yükle
    switch (currentTab) {
      case 'dashboard': loadDashboard(); break;
      case 'files': loadFiles(); break;
      case 'ips': loadBannedIPs(); break;
      case 'settings': loadSettings(); break;
    }
  });
});

// =========================================================================
// API Yardımcısı
// =========================================================================

async function apiFetch(url, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  const resp = await fetch(url, { ...options, headers });

  // HTTP 4xx/5xx durumlarını konsola yaz — hata ayıklama için görünür kalsın
  if (!resp.ok && resp.status !== 401) {
    console.error(`[admin] ${options.method || 'GET'} ${url} → HTTP ${resp.status}`);
  }

  if (resp.status === 401) {
    // Token expired/invalid
    token = null;
    localStorage.removeItem('filesfly_admin_token');
    showLogin();
    throw new Error('Unauthorized');
  }

  return resp;
}

// =========================================================================
// Dashboard
// =========================================================================

async function loadDashboard() {
  try {
    const resp = await apiFetch('/api/admin/stats');
    const data = await resp.json();

    // Stat kartları
    DOM.statsGrid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${data.total_files}</div>
        <div class="stat-label">Toplam Dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.active_files}</div>
        <div class="stat-label">Aktif Dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatSize(data.total_size_bytes)}</div>
        <div class="stat-label">Toplam Boyut</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.today_uploads}</div>
        <div class="stat-label">Bugün</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.unique_sessions_7d}</div>
        <div class="stat-label">Benzersiz Kullanıcı (7g)</div>
      </div>
    `;

    // Günlük istatistik
    if (data.daily_stats && data.daily_stats.length > 0) {
      DOM.dailyStats.innerHTML = `
        <table class="admin-table">
          <thead><tr><th>Gün</th><th>Yükleme</th></tr></thead>
          <tbody>
            ${data.daily_stats.map(d => `
              <tr><td>${d.day}</td><td>${d.count}</td></tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else {
      DOM.dailyStats.innerHTML = '<p class="text-muted text-sm">Son 7 günde yükleme yok.</p>';
    }
  } catch (err) {
    console.error('[loadDashboard] error:', err);
    if (err.message !== 'Unauthorized') {
      DOM.statsGrid.innerHTML = '<div class="stat-card"><div class="stat-label text-error">Yüklenemedi</div></div>';
    }
  }
}

// =========================================================================
// Dosya Listesi
// =========================================================================

async function loadFiles(page = 1) {
  filesPage = page;

  const search = DOM.filesSearch.value.trim();
  const mimeType = DOM.filesMimeFilter.value;

  const params = new URLSearchParams({ page, limit: 50 });
  if (search) params.set('search', search);
  if (mimeType) params.set('mime_type', mimeType);

  try {
    const resp = await apiFetch(`/api/admin/files?${params}`);
    const data = await resp.json();

    filesTotalPages = data.pages;

    // Tablo
    if (data.files.length === 0) {
      DOM.filesTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Dosya bulunamadı.</td></tr>';
    } else {
      DOM.filesTableBody.innerHTML = data.files.map(f => {
        const expired = new Date(f.expire_at) < new Date();
        // CSP-safe: use class instead of inline style
        const expiredSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" class="icon-error icon-va-mid"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
        const timeLeft = expired ? `${expiredSvg} Süresi doldu` : getTimeLeft(f.expire_at);
        const isImage = f.mime_type && f.mime_type.startsWith('image/');
        const icon = getFileIcon(f.mime_type);
        const shortHash = f.ip_hash ? f.ip_hash.substring(0, 12) + '...' : '-';

        // Image thumbnail — compressed /thumb kullan, full /dl'ye düş (şifreli ise ikon)
        const showImageThumb = isImage && !f.is_encrypted;
        const iconOrThumb = showImageThumb
          ? `<img src="/api/files/${f.id}/thumb" alt="" loading="lazy" class="file-item-thumb" data-fallback-icon="${escapeHtml(f.mime_type || '')}" data-fallback-dl="/api/files/${f.id}/dl">`
          : `<span class="file-item-icon">${icon}</span>`;

        // Şifreli dosyalar için kilit rozeti
        const lockBadge = f.is_encrypted
          ? `<span class="encrypted-lock-badge" title="Parola korumalı"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>`
          : '';

        return `
          <tr class="file-table-row row-clickable" data-id="${f.id}" data-name="${escapeHtml(f.filename)}" data-encrypted="${f.is_encrypted ? '1' : '0'}">
            <td>
              ${iconOrThumb}
              <span title="${escapeHtml(f.filename)}">${truncate(f.filename, 30)}</span> ${lockBadge}
            </td>
            <td><span class="mono" title="${f.ip_hash}">${shortHash}</span></td>
            <td>${formatSize(f.file_size)}</td>
            <td>${f.mime_type || '-'}</td>
            <td>${timeLeft}</td>
            <td>
              <button class="btn btn-ghost btn-sm btn-icon delete-file-btn" data-id="${f.id}" data-name="${escapeHtml(f.filename)}" title="Sil" aria-label="Sil">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Fix image fallback: /thumb yüklenemezse önce full /dl, o da olmazsa ikon
      DOM.filesTableBody.querySelectorAll('img.file-item-thumb').forEach(img => {
        img.addEventListener('error', () => {
          const dlFallback = img.dataset.fallbackDl;
          const currentSrc = img.getAttribute('src') || '';
          if (dlFallback && currentSrc !== dlFallback) {
            img.setAttribute('src', dlFallback);
            return;
          }
          const mime = img.dataset.fallbackIcon || '';
          const span = document.createElement('span');
          span.className = 'file-item-icon';
          span.innerHTML = getFileIcon(mime);
          img.replaceWith(span);
        });
      });
    }

    // Sayfalama
    DOM.filesPageInfo.textContent = `Sayfa ${data.page} / ${data.pages} (${data.total} dosya)`;
    DOM.filesPrevBtn.disabled = data.page <= 1;
    DOM.filesNextBtn.disabled = data.page >= data.pages;

    // Event listener'lar — row click = preview, delete button = sil
    document.querySelectorAll('.file-table-row').forEach(row => {
      row.addEventListener('click', () => openPreview(row.dataset.id, row.dataset.name));
    });
    document.querySelectorAll('.delete-file-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // row click'i engelle
        deleteFile(btn.dataset.id, btn.dataset.name);
      });
    });
  } catch (err) {
    console.error('[loadFiles] error:', err);
    if (err.message !== 'Unauthorized') {
      DOM.filesTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-error">Yüklenemedi.</td></tr>';
    }
  }
}

// Arama
DOM.filesSearchBtn.addEventListener('click', () => loadFiles(1));
DOM.filesSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFiles(1);
});
DOM.filesMimeFilter.addEventListener('change', () => loadFiles(1));

// Sayfalama
DOM.filesPrevBtn.addEventListener('click', () => loadFiles(filesPage - 1));
DOM.filesNextBtn.addEventListener('click', () => loadFiles(filesPage + 1));

// =========================================================================
// Dosya Önizleme
// =========================================================================

async function openPreview(fileId, filename) {
  previewFileId = fileId;
  // Preserve the SVG icon in the title if present
  const titleIcon = DOM.previewTitle.querySelector('svg');
  const titleIconHtml = titleIcon ? titleIcon.outerHTML : '';
  if (titleIconHtml) {
    DOM.previewTitle.innerHTML = titleIconHtml + ` Dosya Önizleme: ${escapeHtml(filename)}`;
  } else {
    DOM.previewTitle.textContent = `Dosya Önizleme: ${filename}`;
  }
  DOM.previewContent.innerHTML = '<p class="text-muted text-sm">Yükleniyor...</p>';
  DOM.previewPanel.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Scroll lock
  DOM.previewDownloadBtn.href = `/api/files/${fileId}/dl`;
  DOM.previewDownloadBtn.setAttribute('download', filename);

  try {
    const resp = await apiFetch(`/api/admin/files/${fileId}/preview`);
    const data = await resp.json();

    // Şifreli dosya: parola gate aç (preview modal'ı kapat, gate'i göster)
    if (data.type === 'encrypted') {
      closePreview();
      openAdminPasswordGate(data, 'preview');
      return;
    }

    switch (data.type) {
      case 'text':
        DOM.previewContent.innerHTML = `<pre>${escapeHtml(data.content)}</pre>`;
        if (data.truncated) {
          DOM.previewContent.innerHTML += '<p class="text-muted text-xs mt-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:3px;color:#f59e0b"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Dosya çok büyük, sadece ilk 100KB gösteriliyor.</p>';
        }
        break;

  // Image
      case 'image': {
        // Admin panel: compressed thumbnail (preview-img admin endpoint, token ile)
        // yoksa public /thumb, o da yoksa full /dl.
        const adminThumb = (data.thumbnail_url && token)
          ? data.thumbnail_url + '?token=' + encodeURIComponent(token)
          : `/api/files/${fileId}/thumb`;

        DOM.previewContent.innerHTML = `
          <a href="${data.full_url}" target="_blank" rel="noopener" title="Tam çözünürlük aç (${formatSize(parseInt(data.total_size))})" class="preview-img-link">
            <img src="${adminThumb}" alt="${escapeHtml(filename)}" class="preview-thumb-img"
              data-fallback="${data.full_url}"
            >
          </a>
          <p class="text-muted text-xs mt-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:3px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Tam çözünürlük için resme tıkla (${formatSize(parseInt(data.total_size))})</p>
        `;
        // Thumbnail yüklenemezse full /dl'ye düş
        const thumbImg = DOM.previewContent.querySelector('img.preview-thumb-img');
        if (thumbImg) {
          thumbImg.addEventListener('error', () => {
            const fb = thumbImg.dataset.fallback;
            if (fb && thumbImg.getAttribute('src') !== fb) {
              thumbImg.setAttribute('src', fb);
            }
          });
        }
        break;
      }

      case 'media':
        DOM.previewContent.innerHTML = `
          <video controls style="max-width:100%;">
            <source src="/api/files/${fileId}/dl" type="${data.mime_type}">
            Tarayıcınız video oynatmayı desteklemiyor.
          </video>
        `;
        break;

      case 'pdf':
        DOM.previewContent.innerHTML = `
          <p class="text-muted text-sm mb-1">PDF dosyası — tarayıcıda görüntülemek için indirme linkine tıklayın.</p>
          <iframe src="/api/files/${fileId}/dl" style="width:100%;height:400px;border:none;border-radius:8px;"></iframe>
        `;
        break;

      case 'unsupported':
      case 'error':
      default:
        DOM.previewContent.innerHTML = `<p class="text-muted">${data.content || 'Önizleme kullanılamıyor.'}</p>`;
        break;
    }
  } catch (err) {
    console.error('[openPreview] error:', err);
    DOM.previewContent.innerHTML = '<p class="text-error">Önizleme yüklenemedi.</p>';
  }
}

// Modal kapatma: ✕ butonu, overlay dışına tıklama, Escape tuşu
function closePreview() {
  DOM.previewPanel.classList.add('hidden');
  document.body.style.overflow = ''; // Scroll lock'u kaldır
  previewFileId = null;
  // Video/audio durdur
  const media = DOM.previewContent.querySelector('video, audio');
  if (media) media.pause();
}

DOM.previewCloseBtn.addEventListener('click', closePreview);

// Overlay'e (modal kutusu dışına) tıklayınca kapat
DOM.previewPanel.addEventListener('click', (e) => {
  if (e.target === DOM.previewPanel) closePreview();
});

// Escape tuşu ile kapat
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.previewPanel.classList.contains('hidden')) {
    closePreview();
  }
});

// Preview'dan silme
DOM.previewDeleteBtn.addEventListener('click', () => {
  if (previewFileId) {
    deleteFile(previewFileId, '');
    DOM.previewPanel.classList.add('hidden');
  }
});

// =========================================================================
// Parola Gate (şifreli dosyalar için önizleme/indirme)
// =========================================================================
// Admin panelinde şifreli dosyaların ham /dl endpoint'i ciphertext döndürür
// (görüntülenemez). Bu yüzden parola gate ile tarayıcıda deşifre edilir:
//   - "Önizle": deşifre edip preview modal'ında göster (image/video/pdf/text)
//   - "Çöz ve İndir": deşifre edip orijinal dosyayı indir

function openAdminPasswordGate(meta, mode) {
  gateFileMeta = meta;
  gateMode = mode || 'preview';
  if (gateDecryptedBlobUrl) { URL.revokeObjectURL(gateDecryptedBlobUrl); gateDecryptedBlobUrl = null; }

  DOM.adminGateFilename.textContent = meta.filename || 'Dosya';
  DOM.adminGatePasswordInput.value = '';
  DOM.adminGateError.classList.add('hidden');
  DOM.adminGateProgress.classList.add('hidden');
  DOM.adminGateProgressFill.style.width = '0%';
  DOM.adminPasswordGate.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => DOM.adminGatePasswordInput.focus(), 50);
}

function closeAdminPasswordGate() {
  DOM.adminPasswordGate.classList.add('hidden');
  document.body.style.overflow = '';
}

// Modal dışına tıklayınca kapat
DOM.adminPasswordGate.addEventListener('click', (e) => {
  if (e.target === DOM.adminPasswordGate) closeAdminPasswordGate();
});

// Escape ile kapat
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.adminPasswordGate.classList.contains('hidden')) {
    closeAdminPasswordGate();
  }
});

// Parola göster/gizle
DOM.adminGateToggleVisibility.addEventListener('click', () => {
  const input = DOM.adminGatePasswordInput;
  input.type = input.type === 'password' ? 'text' : 'password';
});

// Enter ile preview
DOM.adminGatePasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') DOM.adminGatePreviewBtn.click();
});

// "Önizle" butonu
DOM.adminGatePreviewBtn.addEventListener('click', () => {
  handleAdminGateSubmit('preview');
});

// "Çöz ve İndir" butonu
DOM.adminGateDownloadBtn.addEventListener('click', () => {
  handleAdminGateSubmit('download');
});

async function handleAdminGateSubmit(mode) {
  if (!gateFileMeta) return;
  gateMode = mode;

  const password = DOM.adminGatePasswordInput.value;
  if (!password) {
    showAdminGateError('Lütfen parolayı girin.');
    return;
  }
  if (!gateFileMeta.encryption_iv || !gateFileMeta.encryption_salt) {
    showAdminGateError('Şifreleme bilgileri eksik. Dosya hasarlı olabilir.');
    return;
  }

  DOM.adminGateError.classList.add('hidden');
  DOM.adminGateProgress.classList.remove('hidden');
  setAdminGateProgress(10, 'Şifreli dosya indiriliyor...');

  // Butonları disable et
  DOM.adminGatePreviewBtn.disabled = true;
  DOM.adminGateDownloadBtn.disabled = true;

  try {
    // 1. Ciphertext'i indir (admin auth gerekli değil — /api/files/:id/dl public)
    const dlResp = await fetch(gateFileMeta.download_url || `/api/files/${gateFileMeta.id || previewFileId}/dl`);
    if (!dlResp.ok) {
      throw new Error('Dosya indirilemedi (HTTP ' + dlResp.status + ').');
    }
    const ciphertext = await dlResp.arrayBuffer();
    setAdminGateProgress(50, 'Şifre çözülüyor...');

    // 2. Deşifrele (FFCrypto — crypto.js)
    const plaintext = await FFCrypto.decryptFile(
      ciphertext,
      gateFileMeta.encryption_iv,
      gateFileMeta.encryption_salt,
      password
    );

    setAdminGateProgress(90, 'İçerik hazırlanıyor...');

    // 3. Blob URL
    const blob = new Blob([plaintext], { type: gateFileMeta.mime_type || 'application/octet-stream' });
    if (gateDecryptedBlobUrl) URL.revokeObjectURL(gateDecryptedBlobUrl);
    gateDecryptedBlobUrl = URL.createObjectURL(blob);

    setAdminGateProgress(100, 'Hazır!');
    DOM.adminGateProgressText.textContent = 'Kilit açıldı.';

    if (gateMode === 'download') {
      // İndir
      const a = document.createElement('a');
      a.href = gateDecryptedBlobUrl;
      a.download = gateFileMeta.filename || 'dosya';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(closeAdminPasswordGate, 500);
    } else {
      // Önizle — deşifre edilmiş blob'ı preview modal'ında göster
      closeAdminPasswordGate();
      showDecryptedPreview(gateFileMeta, gateDecryptedBlobUrl);
    }
  } catch (err) {
    console.error('[admin gate] decrypt error:', err);
    showAdminGateError(err.message || 'Şifre çözme başarısız. Parola yanlış olabilir.');
    DOM.adminGateProgress.classList.add('hidden');
  } finally {
    DOM.adminGatePreviewBtn.disabled = false;
    DOM.adminGateDownloadBtn.disabled = false;
  }
}

/**
 * Deşifre edilmiş blob URL'i preview modal'ında gösterir.
 * (Admin /preview endpoint'i şifreli dosyalar için ciphertext/encrypted tipi döndürür,
 * bu yüzden deşifre edilmiş içeriği burada elle render ederiz.)
 */
function showDecryptedPreview(meta, blobUrl) {
  previewFileId = meta.id || previewFileId;
  const titleIcon = DOM.previewTitle.querySelector('svg');
  const titleIconHtml = titleIcon ? titleIcon.outerHTML : '';
  DOM.previewTitle.innerHTML = titleIconHtml + ` Dosya Önizleme: ${escapeHtml(meta.filename)}`;
  DOM.previewDownloadBtn.href = blobUrl;
  DOM.previewDownloadBtn.setAttribute('download', meta.filename || '');
  DOM.previewPanel.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const mimeType = meta.mime_type || 'application/octet-stream';
  const filename = meta.filename || 'Dosya';

  if (mimeType.startsWith('image/')) {
    DOM.previewContent.innerHTML = `
      <a href="${blobUrl}" target="_blank" rel="noopener" title="Tam çözünürlük aç" class="preview-img-link">
        <img src="${blobUrl}" alt="${escapeHtml(filename)}" class="preview-thumb-img">
      </a>
      <p class="text-muted text-xs mt-1">Deşifre edilmiş önizleme</p>
    `;
  } else if (mimeType.startsWith('video/')) {
    DOM.previewContent.innerHTML = `
      <video controls style="max-width:100%;">
        <source src="${blobUrl}" type="${mimeType}">
        Tarayıcınız video oynatmayı desteklemiyor.
      </video>
    `;
  } else if (mimeType.startsWith('audio/')) {
    DOM.previewContent.innerHTML = `
      <audio controls style="width:100%;">
        <source src="${blobUrl}" type="${mimeType}">
        Tarayıcınız ses oynatmayı desteklemiyor.
      </audio>
    `;
  } else if (mimeType === 'application/pdf') {
    DOM.previewContent.innerHTML = `
      <iframe src="${blobUrl}" style="width:100%;height:400px;border:none;border-radius:8px;"></iframe>
    `;
  } else {
    // Text/octet-stream — blob'u text olarak okumayı dene
    fetch(blobUrl).then(r => r.text()).then(text => {
      DOM.previewContent.innerHTML = `<pre>${escapeHtml(text.substring(0, 100 * 1024))}</pre>`;
      if (text.length >= 100 * 1024) {
        DOM.previewContent.innerHTML += '<p class="text-muted text-xs mt-1">Dosya çok büyük, sadece ilk 100KB gösteriliyor.</p>';
      }
    }).catch(() => {
      DOM.previewContent.innerHTML = `<p class="text-muted">Bu dosya türü için önizleme yok. İndirme linkini kullanın.</p>`;
    });
  }
}

function showAdminGateError(message) {
  DOM.adminGateError.textContent = message;
  DOM.adminGateError.classList.remove('hidden');
}

function setAdminGateProgress(percent, text) {
  DOM.adminGateProgressFill.style.width = percent + '%';
  DOM.adminGateProgressText.textContent = text;
}

// =========================================================================
// Dosya Silme
// =========================================================================

async function deleteFile(fileId, filename) {
  if (filename && !confirm(`${filename} dosyasını silmek istediğinize emin misiniz?`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/admin/files/${fileId}`, { method: 'DELETE' });
    if (resp.ok) {
      loadFiles(filesPage); // Listeyi yenile
    }
  } catch (err) {
    console.error('[deleteFile] error:', err);
    if (err.message !== 'Unauthorized') {
      alert('Dosya silinemedi.');
    }
  }
}

// =========================================================================
// IP Yönetimi
// =========================================================================

async function loadBannedIPs() {
  try {
    const resp = await apiFetch('/api/admin/banned-ips');
    const data = await resp.json();

    if (data.ips.length === 0) {
      DOM.bannedIpsList.innerHTML = '<p class="text-muted text-sm">Yasaklı IP yok.</p>';
      return;
    }

    DOM.bannedIpsList.innerHTML = `
      <table class="admin-table">
        <thead>
          <tr><th>IP Hash</th><th>Sebep</th><th>Tarih</th><th>Bitiş</th><th>İşlem</th></tr>
        </thead>
        <tbody>
          ${data.ips.map(ip => `
            <tr>
              <td><span class="mono">${ip.ip_hash.substring(0, 16)}...</span></td>
              <td>${escapeHtml(ip.reason || '-')}</td>
              <td>${new Date(ip.banned_at).toLocaleDateString('tr-TR')}</td>
              <td>${ip.expires_at ? new Date(ip.expires_at).toLocaleString('tr-TR') : 'Kalıcı'}</td>
                <td>
                  <button class="btn btn-ghost btn-sm unban-btn" data-hash="${ip.ip_hash}">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>
                    Kaldır
                  </button>
                </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Unban butonları
    document.querySelectorAll('.unban-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ipHash = btn.dataset.hash;
        if (!confirm('Bu IP banını kaldırmak istediğinize emin misiniz?')) return;

        try {
          const resp = await apiFetch(`/api/admin/ban-ip-hash/${encodeURIComponent(ipHash)}`, {
            method: 'DELETE',
          });
          if (resp.ok) {
            loadBannedIPs(); // Listeyi yenile
          } else {
            const data = await resp.json();
            alert(data.error || 'Ban kaldırılamadı.');
          }
        } catch (err) {
          if (err.message !== 'Unauthorized') {
            alert('Ban kaldırılamadı.');
          }
        }
      });
    });
  } catch (err) {
    console.error('[loadBannedIPs] error:', err);
    if (err.message !== 'Unauthorized') {
      DOM.bannedIpsList.innerHTML = '<p class="text-error text-sm">Yüklenemedi.</p>';
    }
  }
}

// IP Ban
DOM.banIpBtn.addEventListener('click', async () => {
  const ip = DOM.banIpInput.value.trim();
  const reason = DOM.banReasonInput.value.trim();
  const duration = DOM.banDurationSelect.value;

  if (!ip) {
    DOM.banError.textContent = 'IP adresi gerekli.';
    DOM.banError.classList.remove('hidden');
    return;
  }

  DOM.banIpBtn.disabled = true;
  DOM.banError.classList.add('hidden');

  try {
    const body = { ip_address: ip, reason: reason || 'Manual ban' };
    if (duration) body.duration_hours = parseInt(duration);

    const resp = await apiFetch('/api/admin/ban-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      DOM.banIpInput.value = '';
      DOM.banReasonInput.value = '';
      DOM.banDurationSelect.value = '';
      loadBannedIPs();
    } else {
      const data = await resp.json();
      DOM.banError.textContent = data.error || 'IP yasaklanamadı.';
      DOM.banError.classList.remove('hidden');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      DOM.banError.textContent = 'Bağlantı hatası.';
      DOM.banError.classList.remove('hidden');
    }
  } finally {
    DOM.banIpBtn.disabled = false;
  }
});

// =========================================================================
// Ayarlar
// =========================================================================

async function loadSettings() {
  try {
    const resp = await apiFetch('/api/admin/config');
    const data = await resp.json();
    const config = data.config;

    DOM.settingsForm.innerHTML = `
      <div class="form-group">
        <label class="form-label">Maksimum Dosya Boyutu (MB)</label>
        <input type="number" id="cfg-max_file_size_mb" class="form-input" value="${config.max_file_size_mb || 100}" min="1" max="10000">
      </div>
      <div class="form-group">
        <label class="form-label">Rate Limit (istek / dakika)</label>
        <div class="flex gap-1">
          <input type="number" id="cfg-rate_limit_requests" class="form-input" value="${config.rate_limit_requests || 10}" min="1" max="1000" style="flex:1;">
          <span class="text-muted text-sm" style="align-self:center;">/</span>
          <input type="number" id="cfg-rate_limit_window_minutes" class="form-input" value="${config.rate_limit_window_minutes || 60}" min="1" max="1440" style="flex:1;">
          <span class="text-muted text-sm" style="align-self:center;">dakika</span>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Varsayılan Saklama Süresi (saat)</label>
        <input type="number" id="cfg-default_expire_hours" class="form-input" value="${config.default_expire_hours || 1}" min="1" max="720">
      </div>
      <div class="form-group">
        <label class="form-label">Maksimum Saklama Süresi (saat)</label>
        <input type="number" id="cfg-max_expire_hours" class="form-input" value="${config.max_expire_hours || 48}" min="1" max="720">
      </div>
      <div class="form-group">
        <label class="form-label">İzin Verilen Dosya Türleri</label>
        <input type="text" id="cfg-allowed_mime_types" class="form-input" value="${escapeHtml(config.allowed_mime_types || '*')}" placeholder="* veya image/*,video/*,text/*">
        <span class="text-xs text-muted">* = tümü, image/* = tüm resimler, virgülle ayırın</span>
      </div>
      <div class="form-group">
        <label class="form-label">Chunk Boyutu (MB)</label>
        <input type="number" id="cfg-chunk_size_mb" class="form-input" value="${config.chunk_size_mb || 5}" min="1" max="100">
      </div>
      <div class="form-group">
        <label class="form-label">Temizleme Sıklığı (dakika)</label>
        <input type="number" id="cfg-cleanup_interval_minutes" class="form-input" value="${config.cleanup_interval_minutes || 15}" min="1" max="1440">
      </div>
    `;
  } catch (err) {
    console.error('[loadSettings] error:', err);
    if (err.message !== 'Unauthorized') {
      DOM.settingsForm.innerHTML = '<p class="text-error">Ayarlar yüklenemedi.</p>';
    }
  }
}

// Ayarları Kaydet
DOM.settingsSaveBtn.addEventListener('click', async () => {
  const keys = [
    'max_file_size_mb', 'rate_limit_requests', 'rate_limit_window_minutes',
    'default_expire_hours', 'max_expire_hours', 'allowed_mime_types',
    'chunk_size_mb', 'cleanup_interval_minutes',
  ];

  const updates = {};
  for (const key of keys) {
    const el = document.getElementById(`cfg-${key}`);
    if (el) updates[key] = el.value;
  }

  DOM.settingsSaveBtn.disabled = true;

  try {
    const resp = await apiFetch('/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    if (resp.ok) {
      DOM.settingsSaved.classList.remove('hidden');
      setTimeout(() => DOM.settingsSaved.classList.add('hidden'), 3000);
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Ayarlar kaydedilemedi.');
    }
  } finally {
    DOM.settingsSaveBtn.disabled = false;
  }
});

// =========================================================================
// Yardımcılar
// =========================================================================

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getTimeLeft(expireAt) {
  const diffMs = new Date(expireAt) - new Date();
  if (diffMs <= 0) return '<span style="color:var(--color-error)">Süresi doldu</span>';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) return `${Math.floor(hours / 24)}g ${hours % 24}s`;
  if (hours > 0) return `${hours}s ${minutes}dk`;
  return `${minutes}dk`;
}

function getFileIcon(mimeType) {
  const svg = (path) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">${path}</svg>`;
  if (!mimeType) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  if (mimeType.startsWith('image/')) return svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
  if (mimeType.startsWith('video/')) return svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>');
  if (mimeType.startsWith('audio/')) return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
  if (mimeType.includes('pdf')) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>');
  if (mimeType.includes('zip') || mimeType.includes('rar')) return svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>');
  if (mimeType.startsWith('text/')) return svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
  return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
