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

// Aktif dil — app.js ile aynı localStorage key'i (filesfly_lang). admin.js kendi
// başına yüklendiği için app.js'in currentLang'ine güvenemeyiz; burada tanımlı.
// Render fonksiyonları (renderStorageQuotaBar vb.) bu değeri kullanır.
let currentLang = localStorage.getItem('filesfly_lang') || 'tr';

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
    dbg?.warn('login', 'Boş alan — kullanıcı adı veya parola girilmedi');
    DOM.loginError.textContent = 'Kullanıcı adı ve parola gerekli.';
    DOM.loginError.classList.remove('hidden');
    return;
  }

  dbg.info('login', 'Login attempt', { username });
  DOM.loginBtn.disabled = true;
  DOM.loginError.classList.add('hidden');

  try {
    dbg.time('login', 'POST /api/admin/login');
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    dbg.timeEnd('login', 'POST /api/admin/login');

    const data = await resp.json();

    if (!resp.ok) {
      dbg.warn('login', 'Login rejected', { status: resp.status, error: data.error });
      DOM.loginError.textContent = data.error || 'Giriş başarısız.';
      DOM.loginError.classList.remove('hidden');
      return;
    }

    dbg.info('login', '✓ Login successful', { username, tokenLen: data.token?.length });
    token = data.token;
    localStorage.setItem('filesfly_admin_token', token);
    showAdmin();
  } catch (err) {
    dbg.error('login', 'Connection error', err);
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

  const method = options.method || 'GET';
  dbg.info('api', `→ ${method} ${url}`);
  dbg.time('api', `${method} ${url}`);
  const resp = await fetch(url, { ...options, headers });
  dbg.timeEnd('api', `${method} ${url}`);

  // HTTP 4xx/5xx durumlarını konsola yaz — hata ayıklama için görünür kalsın
  if (!resp.ok && resp.status !== 401) {
    dbg.error('api', `← ${method} ${url} → HTTP ${resp.status}`);
    console.error(`[admin] ${options.method || 'GET'} ${url} → HTTP ${resp.status}`);
  } else {
    dbg.log('api', `← ${method} ${url} → HTTP ${resp.status}`);
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
        <div class="stat-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="stat-value">${data.total_files}</div>
        <div class="stat-label">Toplam Dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="stat-value">${data.active_files}</div>
        <div class="stat-label">Aktif Dosya</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        </div>
        <div class="stat-value">${formatSize(data.total_size_bytes)}</div>
        <div class="stat-label">Toplam Boyut</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </div>
        <div class="stat-value">${data.today_uploads}</div>
        <div class="stat-label">Bugün Yüklenen</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
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

// =========================================================================
// Storage Credential Modal — kapatma handler'ları
// =========================================================================
const credModal = document.getElementById('storage-cred-modal');
const credModalClose = document.getElementById('storage-cred-modal-close');

function closeStorageCredModal() {
  if (credModal) credModal.classList.add('hidden');
}

if (credModalClose) {
  credModalClose.addEventListener('click', closeStorageCredModal);
}
// Overlay'e tıklayınca kapat
if (credModal) {
  credModal.addEventListener('click', (e) => {
    if (e.target === credModal) closeStorageCredModal();
  });
}
// Escape ile kapat (credential modal için ayrı)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && credModal && !credModal.classList.contains('hidden')) {
    closeStorageCredModal();
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

// Storage backend status cache — loadSettings tarafından doldurulur
let storageBackendsCache = [];

/**
 * Bir backend kartı için kullanım/kota progress bar HTML'i üretir.
 * Backend status objesi: { usage_bytes, file_count, quota_bytes, ... }
 *  - quota_bytes null/0 → "Sınırsız" (sadece kullanım, fill tek nokta)
 *  - aksi halde yüzde: ok <70 (yeşil), warn 70-90 (sarı), critical >90 (kırmızı)
 */
function renderStorageQuotaBar(b) {
  const usage = b.usage_bytes || 0;
  const fileCount = b.file_count || 0;
  const quota = b.quota_bytes || 0;
  const usageFmt = formatSize(usage);

  // Kota yok (null/0) → sınırsız mod
  if (!quota) {
    const isUnlimited = !quota;
    return `
      <div class="storage-quota-bar-wrap">
        <div class="storage-quota-meta" data-quota-unlimited="1">
          <span class="storage-quota-meta-label">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M22 12H2"/><path d="M5.45 5.11A8 8 0 1 0 18.93 16"/></svg>
            ${currentLang === 'en' ? 'Used' : 'Kullanılan'}
          </span>
          <span class="storage-quota-meta-value">${usageFmt} <span class="storage-quota-pct">${fileCount} ${currentLang === 'en' ? 'files' : 'dosya'} · ${currentLang === 'en' ? 'Unlimited' : 'Sınırsız'}</span></span>
        </div>
        <div class="storage-quota-track"><div class="storage-quota-fill" data-quota-state="unlimited"></div></div>
      </div>
    `;
  }

  const pct = Math.min(100, Math.round((usage / quota) * 100));
  let state = 'ok';
  if (pct >= 90) state = 'critical';
  else if (pct >= 70) state = 'warn';
  const quotaFmt = formatSize(quota);

  return `
    <div class="storage-quota-bar-wrap">
      <div class="storage-quota-meta">
        <span class="storage-quota-meta-label">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
          ${currentLang === 'en' ? 'Storage' : 'Depolama'}
        </span>
        <span class="storage-quota-meta-value">${usageFmt} / ${quotaFmt} <span class="storage-quota-pct">%${pct} · ${fileCount} ${currentLang === 'en' ? 'files' : 'dosya'}</span></span>
      </div>
      <div class="storage-quota-track"><div class="storage-quota-fill" data-quota-state="${state}" style="width:${pct}%"></div></div>
    </div>
  `;
}

/**
 * Credential modalı için kota seçici (preset pill'ler + custom GB input) üretir.
 * field.presets: [{ label, value(bytes) }], value=0 → "Sınırsız".
 * currentValue: DB'den okunan mevcut byte değeri (string veya null).
 * data-quota-kind="1" → saveStorageCredentials bu input'u özel işler (GB→byte).
 */
function renderQuotaField(field, currentValue) {
  const cur = currentValue ? parseInt(currentValue, 10) : 0;
  const presets = field.presets || [];

  // Mevcut değer hangi preset'e denk geliyor? Hiçbiri → custom mod.
  let matchedPreset = null;
  for (const p of presets) {
    if (p.value === cur) { matchedPreset = p; break; }
  }
  const isCustom = !matchedPreset && cur > 0;
  const customGb = isCustom ? (cur / (1024 ** 3)).toString() : '';

  const presetHtml = presets.map((p, i) => {
    const selected = matchedPreset && matchedPreset.value === p.value;
    return `
      <label class="storage-quota-preset">
        <input type="radio" name="quota-preset" value="${p.value}" data-quota-preset="1" ${selected ? 'checked' : ''}>
        <span>${escapeHtml(p.label)}</span>
      </label>
    `;
  }).join('');

  // "Sınırsız" preset seçiliyse (value=0) → unltd; custom input disabled.
  const unltdSelected = matchedPreset && matchedPreset.value === 0;

  return `
    <div class="storage-quota-field">
      <label class="storage-quota-field-label">${escapeHtml(field.label)}</label>
      <p class="storage-quota-field-hint">${currentLang === 'en'
        ? 'How much storage this backend should allow. Files Fly tracks usage from the database and rejects uploads when the limit is reached.'
        : "Bu backend'in ne kadar depolamaya izin vereceğini belirler. Files Fly kullanımı veritabanından takip eder ve limite ulaşılınca yüklemeleri reddeder."}</p>
      <div class="storage-quota-presets">${presetHtml}</div>
      <label class="storage-quota-custom-toggle">
        <input type="radio" name="quota-preset" value="custom" data-quota-preset-custom="1" ${isCustom ? 'checked' : ''}>
        <span>${currentLang === 'en' ? 'Custom value' : 'Özel değer'}</span>
      </label>
      <div class="storage-quota-custom-row" data-disabled="${(isCustom || unltdSelected === false && matchedPreset) ? '0' : '1'}">
        <input type="number" min="0" step="0.1" class="form-input storage-quota-custom-input storage-cred-input"
               data-key="${field.key}" data-secret="0" data-quota-kind="1" data-wasset="0"
               value="${escapeHtml(customGb)}" placeholder="örn: 5" autocomplete="off">
        <span class="storage-quota-custom-unit">GB</span>
      </div>
    </div>
  `;
}

async function loadSettings() {
  try {
    const [configResp, storageResp] = await Promise.all([
      apiFetch('/api/admin/config'),
      apiFetch('/api/admin/storage/backends'),
    ]);
    const data = await configResp.json();
    const config = data.config;

    // Storage backend durumunu al (paralel fetch, hata olsa da UI kırılmasın)
    let storageData = null;
    try {
      if (storageResp.ok) storageData = await storageResp.json();
    } catch { /* ignore */ }
    storageBackendsCache = (storageData && storageData.backends) || [];
    const activeBackend = (storageData && storageData.active_backend) || config.storage_backend || 'local';

    // Storage backend seçici HTML'i — karta tıklayınca credential modal açılır
    const backendOptionsHtml = storageBackendsCache.map(b => {
      const isActive = b.backend === activeBackend;
      const hasMissingDeps = !!(b.missingDeps && b.missingDeps.length > 0);
      const trulyDisabled = hasMissingDeps;
      const statusLabel = b.available
        ? (isActive ? '<span class="storage-badge storage-badge-active">Aktif</span>'
                    : '<span class="storage-badge storage-badge-ok">Hazır</span>')
        : (hasMissingDeps
            ? `<span class="storage-badge storage-badge-error" title="${escapeHtml(b.error || '')}">Paket Eksik</span>`
            : `<span class="storage-badge storage-badge-error" title="${escapeHtml(b.error || '')}">Yapılandırılmadı</span>`);
      const labels = { local: 'Disk', r2: 'Cloudflare R2', supabase: 'Supabase Storage' };
      const labelHtml = `<span class="storage-backend-tag-${b.backend}">${labels[b.backend] || b.backend}</span>`;
      const desc = {
        local: 'Dosyalar sunucu diskine kaydedilir. Ek yapılandırma gerektirmez.',
        r2: 'Cloudflare R2 bulut depolama. Çıkış trafik ücretsiz, S3-uyumlu API. Karttan bilgileri güncelleyin.',
        supabase: 'Supabase Storage bulut depolama. S3-uyumlu endpoint. Karttan bilgileri güncelleyin.',
      };
      const credHint = (!b.available && !hasMissingDeps && b.backend !== 'local')
        ? '<div class="storage-backend-error">Bağlanmak için bu karta tıklayın ve bilgilerinizi girin.</div>'
        : (hasMissingDeps ? `<div class="storage-backend-error">${escapeHtml(b.error)}${b.missingDeps ? ' — paketler: ' + escapeHtml(b.missingDeps.join(', ')) : ''}</div>` : '');
      // Click-to-edit hint — tüm backend'ler tıklanabilir (local de kota girmek için).
      const credClickHint = '<div class="storage-backend-cred-hint">Bu karta tıklayınca bağlantı bilgileri ve kota menüsü açılır</div>';
      return `
        <label class="storage-backend-option ${isActive ? 'active' : ''} ${trulyDisabled ? 'disabled' : ''} storage-backend-clickable" data-backend="${b.backend}">
          <input type="radio" name="storage_backend" value="${b.backend}" ${isActive ? 'checked' : ''} ${trulyDisabled ? 'disabled' : ''}>
          <div class="storage-backend-info">
            <div class="storage-backend-name">${labelHtml} ${statusLabel}</div>
            <div class="storage-backend-desc">${desc[b.backend] || ''}</div>
            ${credHint}
            ${credClickHint}
            ${renderStorageQuotaBar(b)}
          </div>
        </label>
      `;
    }).join('');

    // Modern sidebar tab layout: butonlar solda, içerik sağda
    DOM.settingsForm.innerHTML = `
      <div class="settings-layout">
        <!-- Sol sidebar: bölüm butonları -->
        <nav class="settings-sidebar">
          <button type="button" class="settings-tab-btn active" data-settings-tab="storage">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            Dosya Depolama
          </button>
          <button type="button" class="settings-tab-btn" data-settings-tab="general">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Genel Ayarlar
          </button>
          <button type="button" class="settings-tab-btn" data-settings-tab="audit">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            Denetim Günlüğü
          </button>
        </nav>

        <!-- Sağ içerik: panel'ler -->
        <div class="settings-content">
          <!-- PANEL 1: Dosya Depolama -->
          <div class="settings-panel active" data-settings-panel="storage">
            <h3 class="settings-section-title">Dosya Depolama (Object Storage / Bucket)</h3>
            <p class="text-muted text-sm" style="margin-bottom: 1rem;">
              Dosyaların nerede saklanacağını seçin. Yeni dosyalar seçilen backend'e yüklenir;
              mevcut dosyalar kendi backend'inde kalır (backend değişse bile doğru silinir).
              Cloud backend credential'larını "Credential'ları Düzenle" butonuyla (.env yerine DB'de) düzenleyebilirsiniz.
            </p>
            <div class="storage-backend-list" id="storage-backend-list">
              ${backendOptionsHtml}
            </div>

            <div class="text-center mt-2">
              <button type="button" id="storage-apply-btn" class="btn btn-primary">
                Depolama Backend'ini Uygula
              </button>
              <span id="storage-apply-status" class="text-sm text-muted"></span>
            </div>
          </div>

          <!-- PANEL 2: Genel Ayarlar -->
          <div class="settings-panel" data-settings-panel="general">
            <h3 class="settings-section-title">Genel Ayarlar</h3>
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
          </div>

          <!-- PANEL 3: Denetim Günlüğü -->
          <div class="settings-panel" data-settings-panel="audit">
            <h3 class="settings-section-title">Son Değişiklikler (Denetim Günlüğü)</h3>
            <p class="text-muted text-sm" style="margin-bottom: 1rem;">
              Storage credential ve backend değişiklikleri kim tarafından, ne zaman yapıldı.
            </p>
            <div id="audit-log-list"><p class="text-muted text-sm">Yükleniyor...</p></div>
          </div>
        </div>
      </div>
    `;

    // Settings sub-tab switching (sidebar buttons)
    DOM.settingsForm.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.settingsTab;
        // Butonları güncelle
        DOM.settingsForm.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Panel'leri güncelle
        DOM.settingsForm.querySelectorAll('.settings-panel').forEach(p => {
          p.classList.toggle('active', p.dataset.settingsPanel === tab);
        });
      });
    });

    // Audit log'u yükle (form render olduktan sonra)
    loadAuditLog();
  } catch (err) {
    console.error('[loadSettings] error:', err);
    if (err.message !== 'Unauthorized') {
      DOM.settingsForm.innerHTML = '<p class="text-error">Ayarlar yüklenemedi.</p>';
    }
  }
}

/**
 * Audit log'u yükler ve "Son Değişiklikler" bölümünde render eder.
 * GET /api/admin/audit-log → { logs, total, page, pages }
 */
async function loadAuditLog() {
  const listEl = document.getElementById('audit-log-list');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-muted text-sm">Yükleniyor...</p>';
  try {
    const resp = await apiFetch('/api/admin/audit-log?limit=20');
    if (!resp.ok) {
      listEl.innerHTML = '<p class="text-muted text-sm">Denetim günlüğü yüklenemedi.</p>';
      return;
    }
    const data = await resp.json();
    if (!data.logs || data.logs.length === 0) {
      listEl.innerHTML = '<p class="text-muted text-sm">Henüz kayıt yok.</p>';
      return;
    }
    const actionLabels = {
      storage_credential_update: 'Storage Credential Güncelleme',
      storage_backend_switch: 'Storage Backend Değiştirme',
    };
    listEl.innerHTML = `
      <table class="admin-table audit-log-table">
        <thead><tr><th>Admin</th><th>İşlem</th><th>Hedef</th><th>Detay</th><th>Tarih</th></tr></thead>
        <tbody>
          ${data.logs.map(l => {
            const date = new Date(l.created_at).toLocaleString('tr-TR');
            const action = actionLabels[l.action] || escapeHtml(l.action);
            const target = l.target ? escapeHtml(l.target) : '-';
            let detail = '';
            if (l.metadata && l.metadata.updated) {
              detail = `Güncellenen: ${escapeHtml(l.metadata.updated.join(', '))}`;
            } else if (l.metadata && l.metadata.previous) {
              detail = `Önceki: ${escapeHtml(l.metadata.previous)}`;
            }
            return `<tr>
              <td><span class="mono">${escapeHtml(l.admin_user)}</span></td>
              <td>${action}</td>
              <td>${target}</td>
              <td class="text-muted text-sm">${escapeHtml(detail)}</td>
              <td class="text-muted text-sm">${date}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${data.total > data.logs.length ? `<p class="text-muted text-xs mt-1">İlk ${data.logs.length} / ${data.total} kayıt gösteriliyor.</p>` : ''}
    `;
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      listEl.innerHTML = '<p class="text-error text-sm">Yüklenemedi.</p>';
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
// Storage Credential Editör (R2 / Supabase — DB-backed, .env fallback)
// =========================================================================

/**
 * Bir backend'in credential formunu yükler ve panelde gösterir.
 * GET /api/admin/storage/config/:backend → schema + masked config
 * Secret alanlar masked gelir; input boş bırakılırsa veya masked kalırsa
 * mevcut değer korunur (PUT sırasında skip edilir).
 */
async function loadStorageCredentialForm(backend) {
  console.log('[StorageCred] loadStorageCredentialForm → backend:', backend);
  // Modal popup kullan (inline panel değil)
  const modal = document.getElementById('storage-cred-modal');
  const content = document.getElementById('storage-cred-modal-content');
  const titleName = document.getElementById('storage-cred-modal-name');
  if (!modal || !content) {
    console.error('[StorageCred] #storage-cred-modal bulunamadı!');
    alert('Credential modal DOM\'da yok. Sayfayı yenileyin.');
    return;
  }
  // Modal başlığını güncelle
  const labels = { r2: 'Cloudflare R2', supabase: 'Supabase Storage', local: 'Disk' };
  if (titleName) titleName.textContent = `${labels[backend] || backend} — Credential'lar`;
  // Modal box'a backend class'ı ekle (renkli kenarlık için)
  const modalBox = modal.querySelector('.storage-cred-modal-box');
  if (modalBox) {
    modalBox.classList.remove('cred-backend-r2', 'cred-backend-supabase', 'cred-backend-local');
    modalBox.classList.add(`cred-backend-${backend}`);
  }
  // Modal'ı göster
  modal.classList.remove('hidden');
  content.innerHTML = '<p class="text-muted text-sm">Yükleniyor...</p>';

  try {
    const resp = await apiFetch(`/api/admin/storage/config/${backend}`);
    console.log('[StorageCred] API response status:', resp.status);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[StorageCred] API error:', err);
      content.innerHTML = `<p class="text-error text-sm">${escapeHtml(err.error || 'Yüklenemedi')}</p>`;
      return;
    }
    const data = await resp.json();
    console.log('[StorageCred] API data:', { backend: data.backend, schemaFields: (data.schema || []).length, configKeys: Object.keys(data.config || {}) });
    renderStorageCredentialForm(backend, data);
  } catch (err) {
    console.error('[StorageCred] loadStorageCredentialForm error:', err);
    if (err.message !== 'Unauthorized') {
      content.innerHTML = `<p class="text-error text-sm">${escapeHtml(err.message)}</p>`;
    }
  }
}

/**
 * Credential formunu render eder.
 * @param {string} backend
 * @param {{ backend: string, config: Object, schema: Array }} data
 */
function renderStorageCredentialForm(backend, data) {
  console.log('[StorageCred] renderStorageCredentialForm → backend:', backend, 'schema:', data.schema, 'config:', data.config);
  // Modal content alanına render et (inline panel değil)
  const content = document.getElementById('storage-cred-modal-content');
  if (!content) {
    console.error('[StorageCred] #storage-cred-modal-content DOM\'da yok!');
    return;
  }

  const fieldsHtml = (data.schema || []).map(field => {
    const current = data.config[field.key];
    const isSecret = field.secret;

    // Kota field'i (kind:'quota') → preset pill'ler + custom GB input (özel render).
    // Normal text input değil; data-quota-kind="1" ile saveStorageCredentials
    // bu input'u GB→byte çevirerek işler.
    if (field.kind === 'quota') {
      return renderQuotaField(field, current);
    }

    const inputType = isSecret ? 'password' : 'text';
    const placeholderAttr = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';

    // Secret alanlar: backend "Ayarlandı" (set) veya null (unset) döner.
    // ASLA raw değeri input'a koyma. Set ise "Ayarlandı" rozeti + boş input.
    let secretBadge = '';
    let valueAttr = '';
    let secretHint = '';
    if (isSecret) {
      if (current === 'Ayarlandı') {
        secretBadge = '<span class="storage-cred-set-badge">● Ayarlandı</span>';
        secretHint = '<span class="text-xs text-muted">Mevcut değer şifreli saklanıyor. Değiştirmek için yeni değer girin, korumak için boş bırakın.</span>';
      } else {
        secretHint = '<span class="text-xs text-muted">Henüz ayarlanmadı. Yeni değer girin.</span>';
      }
    } else {
      // Non-secret: mevcut değeri input'a koy
      valueAttr = current ? `value="${escapeHtml(current)}"` : '';
    }

    // Secret alanlarda "göster/gizle" toggle
    const toggleBtn = isSecret
      ? `<button type="button" class="storage-secret-toggle" data-target="cred-${field.key}" title="Göster/Gizle"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>`
      : '';
    return `
      <div class="form-group storage-cred-field">
        <label class="form-label" for="cred-${field.key}">${escapeHtml(field.label)}${secretBadge}</label>
        <div class="storage-cred-input-row">
          <input type="${inputType}" id="cred-${field.key}" class="form-input storage-cred-input" data-key="${field.key}" data-secret="${isSecret ? '1' : '0'}" data-wasset="${current === 'Ayarlandı' ? '1' : '0'}" ${valueAttr} ${placeholderAttr} autocomplete="off">
          ${toggleBtn}
        </div>
        ${secretHint}
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="storage-cred-modal-hint">
      Değerler DB'de saklanır (restart'a dayanıklı). .env'de de varsa DB değeri önceliklidir.
      Secret alanlar maskeli gösterilir — yeni değer girmezseniz mevcut değer korunur.
    </div>
    ${fieldsHtml || '<p class="text-muted text-sm">Bu backend\'in düzenlenebilir credential\'ı yok.</p>'}
    <div class="storage-cred-modal-actions">
      <button type="button" id="storage-cred-save" class="btn btn-primary" data-backend="${backend}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        Credential'ları Kaydet
      </button>
      <span id="storage-cred-status" class="text-sm text-muted"></span>
    </div>
  `;

  // Secret göster/gizle toggle
  content.querySelectorAll('.storage-secret-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // --- Kota preset radio'ları: custom input'u disable/enable ---
  const customRow = content.querySelector('.storage-quota-custom-row');
  const customInput = content.querySelector('.storage-quota-custom-input');
  function syncQuotaCustomState() {
    const checked = content.querySelector('input[name="quota-preset"]:checked');
    if (!checked || !customRow) return;
    // Custom radio seçili değilse custom row disable; seçiliyse enable.
    customRow.dataset.disabled = checked.dataset.quotaPresetCustom === '1' ? '0' : '1';
    if (customInput) customInput.disabled = checked.dataset.quotaPresetCustom !== '1';
  }
  content.querySelectorAll('input[name="quota-preset"]').forEach(r => {
    r.addEventListener('change', syncQuotaCustomState);
  });
  syncQuotaCustomState();

  // Kaydet butonu
  const saveBtn = document.getElementById('storage-cred-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveStorageCredentials(backend));
  }

  console.log('[StorageCred] Form modal içine render edildi.');
}

/**
 * Credential formunu toplar ve PUT ile kaydeder.
 * Secret alanlar: değer maskeli ("••••...") veya boşsa skip edilir (mevcut korunur).
 */
async function saveStorageCredentials(backend) {
  const statusEl = document.getElementById('storage-cred-status');
  const saveBtn = document.getElementById('storage-cred-save');
  if (!saveBtn) return;

  const updates = {};
  const inputs = document.querySelectorAll('.storage-cred-input');

  // --- Kota field'i: preset radio seçimini oku, custom input'u GB→byte çevir ---
  const presetChecked = document.querySelector('input[name="quota-preset"]:checked');
  const quotaCustomInput = document.querySelector('.storage-quota-custom-input[data-quota-kind="1"]');
  if (presetChecked && quotaCustomInput) {
    const quotaKey = quotaCustomInput.dataset.key; // QUOTA_BYTES
    if (presetChecked.dataset.quotaPreset === '1') {
      // Bir preset seçili (value byte cinsinden; 0 = Sınırsız)
      updates[quotaKey] = String(presetChecked.value);
    } else if (presetChecked.dataset.quotaPresetCustom === '1') {
      // Custom mod → GB input'unu byte'a çevir
      const gb = parseFloat(quotaCustomInput.value);
      if (!isNaN(gb) && gb > 0) {
        updates[quotaKey] = String(Math.round(gb * 1024 ** 3));
      } else {
        // Geçersiz custom değer → Sınırsız (0)
        updates[quotaKey] = '0';
      }
    }
  }

  inputs.forEach(input => {
    const key = input.dataset.key;
    // Kota input'u yukarıda özel işlendi, atla.
    if (input.dataset.quotaKind === '1') return;
    const isSecret = input.dataset.secret === '1';
    const wasSet = input.dataset.wasset === '1'; // backend "Ayarlandı" döndü mü?
    const val = (input.value || '').trim();

    if (isSecret) {
      // Secret: boş bırakıldıysa → mevcut değeri koru (skip)
      // (backend "Ayarlandı" döndüyse mevcut değer var demektir; boş = koru)
      if (!val) return; // updates'e ekleme → mevcut korunur
      // Yeni değer girildi → güncelle (backend encrypt edip yazacak)
      updates[key] = val;
    } else {
      // Non-secret: boş string geçerli (temizleme). Aynı değerse skip yok
      // çünkü data-original artık tutulmuyor — her non-secret değer update olarak gönderilir,
      // backend zaten same-value ise DB'ye yazar (idempotent).
      updates[key] = val;
    }
  });

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    if (statusEl) { statusEl.textContent = 'Değişiklik yok.'; statusEl.className = 'text-sm text-muted ml-1'; }
    return;
  }

  saveBtn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Kaydediliyor...'; statusEl.className = 'text-sm text-muted ml-1'; }

  try {
    const resp = await apiFetch(`/api/admin/storage/config/${backend}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await resp.json();
    if (resp.ok) {
      if (statusEl) { statusEl.textContent = `✓ ${data.message || 'Kaydedildi'}`; statusEl.className = 'text-sm text-success'; }
      // Modal ayrı DOM elementi (settingsForm dışında) — loadSettings modal'ı silmez.
      // Backend durumunu yenile (credential girilince "Eksik" → "Hazır" olabilir).
      // Modalı 1.5s sonra kapat ve settings'i yenile.
      setTimeout(() => {
        const modal = document.getElementById('storage-cred-modal');
        if (modal) modal.classList.add('hidden');
        loadSettings();
      }, 1500);
    } else {
      if (statusEl) { statusEl.textContent = `✕ ${data.error || 'Başarısız'}`; statusEl.className = 'text-sm text-error'; }
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      if (statusEl) { statusEl.textContent = `✕ ${err.message}`; statusEl.className = 'text-sm text-error ml-1'; }
    }
  } finally {
    saveBtn.disabled = false;
  }
}

// =========================================================================
// Storage Backend Uygula (ayrı buton — config kaydetmeden bağımsız)
// =========================================================================
// "Depolama Backend'ini Uygula" butonu için delegated listener.
// loadSettings her render'da yeni buton ürettiği için static listener yerine
// event delegation kullanıyoruz (settings-form üzerinde).

// Delegated listener: storage backend kart tıklaması (R2/Supabase → credential modal)
// ve "Depolama Backend'ini Uygula" butonunu yakalar.
DOM.settingsForm.addEventListener('click', async (e) => {
  // Storage backend kartına (R2/Supabase) tıklanınca credential modal aç
  const backendCard = e.target.closest('.storage-backend-clickable');
  if (backendCard) {
    const backend = backendCard.dataset.backend;
    // Radio tıklaması hariç (sadece kart body'sine tıklanınca)
    if (e.target.type !== 'radio' && backend && backend !== 'local') {
      e.preventDefault();
      await loadStorageCredentialForm(backend);
      return;
    }
  }

  if (e.target.id !== 'storage-apply-btn') return;

  const selected = DOM.settingsForm.querySelector('input[name="storage_backend"]:checked');
  const statusEl = document.getElementById('storage-apply-status');
  const btn = e.target;

  if (!selected) {
    if (statusEl) { statusEl.textContent = 'Lütfen bir backend seçin.'; statusEl.className = 'text-sm text-error ml-1'; }
    return;
  }

  const backend = selected.value;
  btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Uygulanıyor...'; statusEl.className = 'text-sm text-muted ml-1'; }

  try {
    const resp = await apiFetch('/api/admin/storage/backend', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    });
    const data = await resp.json();
    if (resp.ok) {
      if (statusEl) { statusEl.textContent = `✓ ${data.message || 'Uygulandı'}`; statusEl.className = 'text-sm text-success ml-1'; }
      loadSettings(); // UI'ı yenile (aktif badge güncellensin)
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    } else {
      if (statusEl) { statusEl.textContent = `✕ ${data.error || 'Başarısız'}`; statusEl.className = 'text-sm text-error ml-1'; }
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      if (statusEl) { statusEl.textContent = `✕ ${err.message}`; statusEl.className = 'text-sm text-error ml-1'; }
    }
  } finally {
    btn.disabled = false;
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
