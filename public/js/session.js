/**
 * session.js — Files Fly Dosyalarım Sayfası JavaScript
 * 
 * Kullanıcının kendi yüklediği dosyaları listeler.
 * Session cookie ile otomatik tanımlama.
 * Sayfalama, link kopyalama, indirme, süre sayacı.
 */

// =========================================================================
// DOM Referansları
// =========================================================================

const DOM = {
  fileList: document.getElementById('file-list'),
  loadingState: document.getElementById('loading-state'),
  emptyState: document.getElementById('empty-state'),
  errorState: document.getElementById('error-state'),
  errorText: document.getElementById('error-text'),
  retryLoadBtn: document.getElementById('retry-load-btn'),
  pagination: document.getElementById('pagination'),
  prevPageBtn: document.getElementById('prev-page-btn'),
  nextPageBtn: document.getElementById('next-page-btn'),
  pageInfo: document.getElementById('page-info'),
};

// =========================================================================
// State
// =========================================================================

let currentPage = 1;
let totalPages = 1;
let countdownIntervals = [];

// =========================================================================
// Sayfa Yükleme
// =========================================================================

async function loadFiles(page = 1) {
  // Loading state
  DOM.loadingState.classList.remove('hidden');
  DOM.emptyState.classList.add('hidden');
  DOM.errorState.classList.add('hidden');
  DOM.fileList.innerHTML = '';
  DOM.pagination.classList.add('hidden');

  // Eski countdown interval'ları temizle
  countdownIntervals.forEach(clearInterval);
  countdownIntervals = [];

  try {
    const resp = await fetch(`/api/session/files?page=${page}&limit=20`);

    if (!resp.ok) {
      if (resp.status === 401) {
        // Session yok → oluştur
        await fetch('/api/session', { method: 'POST' });
        return loadFiles(page); // Tekrar dene
      }
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    currentPage = data.page;
    totalPages = data.pages;

    DOM.loadingState.classList.add('hidden');

    if (data.files.length === 0) {
      DOM.emptyState.classList.remove('hidden');
      return;
    }

    // Dosyaları render et
    renderFiles(data.files);

    // Sayfalama
    if (totalPages > 1) {
      DOM.pagination.classList.remove('hidden');
      DOM.pageInfo.textContent = `Sayfa ${currentPage} / ${totalPages}`;
      DOM.prevPageBtn.disabled = currentPage <= 1;
      DOM.nextPageBtn.disabled = currentPage >= totalPages;
    }
  } catch (err) {
    console.error('[Session] Error loading files:', err);
    DOM.loadingState.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
    DOM.errorText.textContent = 'Dosyalar yüklenirken bir hata oluştu. Lütfen tekrar deneyin.';
  }
}

// =========================================================================
// Dosya Render
// =========================================================================

function renderFiles(files) {
  DOM.fileList.innerHTML = '';

  for (const file of files) {
    const expired = new Date(file.expire_at) < new Date();
    const item = document.createElement('div');
    item.className = `file-item${expired ? ' expired' : ''}`;

    const icon = getFileIcon(file.mime_type, file.filename);
    const size = formatSize(file.file_size);
    const timeLeft = expired ? 'Süresi doldu (silindi)' : getTimeLeft(file.expire_at);

    item.innerHTML = `
      <div class="file-item-icon">${icon}</div>
      <div class="file-item-info">
        <div class="file-item-name">${escapeHtml(file.filename)}</div>
        <div class="file-item-meta">
          ${size} — <span class="countdown" data-expire="${file.expire_at}">${timeLeft}</span>
          ${file.download_count > 0 ? ` — ${file.download_count} indirme` : ''}
        </div>
      </div>
      <div class="file-item-actions">
        ${!expired ? `
          <button class="btn btn-ghost btn-sm copy-link-btn" data-url="${escapeHtml(file.direct_url)}">🔗 Linki Kopyala</button>
          <a href="${escapeHtml(file.direct_url)}" class="btn btn-primary btn-sm">📥 İndir</a>
        ` : `
          <span class="text-muted text-xs">🗑️ Silindi</span>
        `}
      </div>
    `;

    DOM.fileList.appendChild(item);

    // Süresi dolmamış dosyalar için countdown başlat
    if (!expired) {
      startCountdown(item, file.expire_at);
    }
  }

  // Link kopyalama butonları
  document.querySelectorAll('.copy-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.dataset.url);
      btn.textContent = '✅ Kopyalandı!';
      setTimeout(() => { btn.textContent = '🔗 Linki Kopyala'; }, 2000);
    });
  });
}

// =========================================================================
// Countdown Timer
// =========================================================================

function startCountdown(itemElement, expireAt) {
  const countdownEl = itemElement.querySelector('.countdown');
  if (!countdownEl) return;

  const update = () => {
    const timeLeft = getTimeLeft(expireAt);
    countdownEl.textContent = timeLeft;

    // Süre doldu mu?
    if (new Date(expireAt) < new Date()) {
      countdownEl.textContent = 'Süresi doldu (silindi)';
      itemElement.classList.add('expired');
      // Butonları güncelle
      const actions = itemElement.querySelector('.file-item-actions');
      if (actions) {
        actions.innerHTML = '<span class="text-muted text-xs">🗑️ Silindi</span>';
      }
      return; // Interval durur
    }
  };

  update();
  const interval = setInterval(update, 30000); // 30 saniyede bir güncelle
  countdownIntervals.push(interval);
}

function getTimeLeft(expireAt) {
  const now = new Date();
  const expire = new Date(expireAt);
  const diffMs = expire - now;

  if (diffMs <= 0) return 'Süresi doldu (silindi)';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days} gün ${hours % 24} saat kaldı`;
  }
  if (hours > 0) {
    return `${hours} saat ${minutes} dk kaldı`;
  }
  return `${minutes} dk kaldı`;
}

// =========================================================================
// Sayfalama
// =========================================================================

DOM.prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    loadFiles(currentPage - 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

DOM.nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages) {
    loadFiles(currentPage + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

DOM.retryLoadBtn.addEventListener('click', () => loadFiles(currentPage));

// =========================================================================
// Yardımcılar
// =========================================================================

function getFileIcon(mimeType, filename) {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return '📦';
  if (mimeType.includes('text') || mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml')) return '📝';
  return '📄';
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
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
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(textarea);
}

// =========================================================================
// Başlat
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
  loadFiles();
});
