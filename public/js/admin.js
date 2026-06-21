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
    DOM.adminUsername.textContent = `👤 ${payload.sub}`;
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
        const timeLeft = expired ? '❌ Süresi doldu' : getTimeLeft(f.expire_at);
        const icon = getFileIcon(f.mime_type);
        const shortHash = f.ip_hash ? f.ip_hash.substring(0, 12) + '...' : '-';

        return `
          <tr>
            <td>
              <span class="file-item-icon">${icon}</span>
              <span title="${escapeHtml(f.filename)}">${truncate(f.filename, 30)}</span>
            </td>
            <td><span class="mono" title="${f.ip_hash}">${shortHash}</span></td>
            <td>${formatSize(f.file_size)}</td>
            <td>${f.mime_type || '-'}</td>
            <td>${timeLeft}</td>
            <td>
              <button class="btn btn-ghost btn-sm preview-btn" data-id="${f.id}" data-name="${escapeHtml(f.filename)}">👁️</button>
              <button class="btn btn-ghost btn-sm delete-file-btn" data-id="${f.id}" data-name="${escapeHtml(f.filename)}">🗑️</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Sayfalama
    DOM.filesPageInfo.textContent = `Sayfa ${data.page} / ${data.pages} (${data.total} dosya)`;
    DOM.filesPrevBtn.disabled = data.page <= 1;
    DOM.filesNextBtn.disabled = data.page >= data.pages;

    // Event listener'lar
    document.querySelectorAll('.preview-btn').forEach(btn => {
      btn.addEventListener('click', () => openPreview(btn.dataset.id, btn.dataset.name));
    });
    document.querySelectorAll('.delete-file-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteFile(btn.dataset.id, btn.dataset.name));
    });
  } catch (err) {
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
  DOM.previewTitle.textContent = `👁️ Dosya Önizleme: ${filename}`;
  DOM.previewContent.innerHTML = '<p class="text-muted text-sm">Yükleniyor...</p>';
  DOM.previewPanel.classList.remove('hidden');
  DOM.previewDownloadBtn.href = `/api/files/${fileId}/dl`;

  try {
    const resp = await apiFetch(`/api/admin/files/${fileId}/preview`);
    const data = await resp.json();

    switch (data.type) {
      case 'text':
        DOM.previewContent.innerHTML = `<pre>${escapeHtml(data.content)}</pre>`;
        if (data.truncated) {
          DOM.previewContent.innerHTML += '<p class="text-muted text-xs mt-1">⚠️ Dosya çok büyük, sadece ilk 100KB gösteriliyor.</p>';
        }
        break;

      case 'image':
        DOM.previewContent.innerHTML = `<img src="${data.content}" alt="${escapeHtml(filename)}">`;
        break;

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
    DOM.previewContent.innerHTML = '<p class="text-error">Önizleme yüklenemedi.</p>';
  }
}

DOM.previewCloseBtn.addEventListener('click', () => {
  DOM.previewPanel.classList.add('hidden');
  previewFileId = null;
});

// Preview'dan silme
DOM.previewDeleteBtn.addEventListener('click', () => {
  if (previewFileId) {
    deleteFile(previewFileId, '');
    DOM.previewPanel.classList.add('hidden');
  }
});

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
                <button class="btn btn-ghost btn-sm unban-btn" data-hash="${ip.ip_hash}">✅ Kaldır</button>
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
  if (diffMs <= 0) return '❌ Süresi doldu';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) return `${Math.floor(hours / 24)}g ${hours % 24}s`;
  if (hours > 0) return `${hours}s ${minutes}dk`;
  return `${minutes}dk`;
}

function getFileIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
  if (mimeType.startsWith('text/')) return '📝';
  return '📄';
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
