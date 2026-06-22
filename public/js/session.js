/**
 * session.js — Files Fly Dosyalarım Sayfası JavaScript
 *
 * Kullanıcının kendi yüklediği dosyaları listeler.
 * Session cookie ile otomatik tanımlama.
 * Sayfalama, link kopyalama, indirme, süre sayacı, önizleme.
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

  // Preview
  previewPanel: document.getElementById('preview-panel'),
  previewTitle: document.getElementById('preview-title'),
  previewContent: document.getElementById('preview-content'),
  previewCloseBtn: document.getElementById('preview-close-btn'),
  previewCloseBtn2: document.getElementById('preview-close-btn2'),
  previewDownloadBtn: document.getElementById('preview-download-btn'),
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
  DOM.loadingState.classList.remove('hidden');
  DOM.emptyState.classList.add('hidden');
  DOM.errorState.classList.add('hidden');
  DOM.fileList.innerHTML = '';
  DOM.pagination.classList.add('hidden');

  countdownIntervals.forEach(clearInterval);
  countdownIntervals = [];

  try {
    const resp = await fetch(`/api/session/files?page=${page}&limit=20`);

    if (!resp.ok) {
      if (resp.status === 401) {
        await fetch('/api/session', { method: 'POST' });
        return loadFiles(page);
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

    renderFiles(data.files);

    if (totalPages > 1) {
      DOM.pagination.classList.remove('hidden');
      DOM.pageInfo.textContent = `Sayfa ${currentPage} / ${totalPages}`;
      DOM.prevPageBtn.disabled = currentPage <= 1;
      DOM.nextPageBtn.disabled = currentPage >= totalPages;
    }
  } catch (err) {
    console.error('[Session] Dosyalar yüklenirken hata:', err);
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
    const isImage = file.mime_type && file.mime_type.startsWith('image/');
    const isPreviewable = !expired && (
      isImage ||
      (file.mime_type && (
        file.mime_type.startsWith('video/') ||
        file.mime_type.startsWith('audio/') ||
        file.mime_type.startsWith('text/') ||
        file.mime_type === 'application/pdf' ||
        file.mime_type === 'application/json' ||
        file.mime_type === 'application/javascript'
      ))
    );

    // Thumbnail: image dosyaları için küçük resim (public dl endpoint)
    const thumbHtml = isImage && !expired
      ? `<img src="/api/files/${file.id}/dl" alt="" loading="lazy" class="file-item-thumb" onerror="this.outerHTML='<span class=\\'file-item-icon\\'>${icon}</span>'">`
      : `<span class="file-item-icon">${icon}</span>`;

    item.innerHTML = `
      ${thumbHtml}
      <div class="file-item-info">
        <div class="file-item-name">${escapeHtml(file.filename)}</div>
        <div class="file-item-meta">
          ${size} — <span class="countdown" data-expire="${file.expire_at}">${timeLeft}</span>
          ${file.download_count > 0 ? ` — ${file.download_count} indirme` : ''}
        </div>
      </div>
      <div class="file-item-actions">
        ${!expired ? `
          ${isPreviewable ? `<button class="btn btn-ghost btn-sm preview-btn" data-id="${file.id}" data-name="${escapeHtml(file.filename)}" data-mime="${escapeHtml(file.mime_type)}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            Önizle
          </button>` : ''}
          <button class="btn btn-ghost btn-sm copy-link-btn" data-url="${escapeHtml(file.direct_url)}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Kopyala
          </button>
          <a href="${escapeHtml(file.direct_url)}" class="btn btn-primary btn-sm" download="${escapeHtml(file.filename)}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            İndir
          </a>
        ` : `
          <span class="text-muted text-xs file-item-deleted">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Silindi
          </span>
        `}
      </div>
    `;

    DOM.fileList.appendChild(item);

    if (!expired) {
      startCountdown(item, file.expire_at);
    }
  }

  // Link kopyalama
  document.querySelectorAll('.copy-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.dataset.url);
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="color:var(--color-success)"><polyline points="20 6 9 17 4 12"/></svg> Kopyalandı!`;
      setTimeout(() => { btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Kopyala`; }, 2000);
    });
  });

  // Preview butonları
  document.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openPreview(btn.dataset.id, btn.dataset.name, btn.dataset.mime);
    });
  });
}

// =========================================================================
// Önizleme
// =========================================================================

async function openPreview(fileId, filename, mimeType) {
  // Keep the SVG icon in the title
  const titleIcon = DOM.previewTitle.querySelector('svg');
  const titleIconHtml = titleIcon ? titleIcon.outerHTML : '';
  if (titleIconHtml) {
    DOM.previewTitle.innerHTML = titleIconHtml + ` Dosya Önizleme: ${escapeHtml(filename)}`;
  } else {
    DOM.previewTitle.textContent = `Dosya Önizleme: ${filename}`;
  }
  DOM.previewContent.innerHTML = '<p class="text-muted text-sm">Yükleniyor...</p>';
  DOM.previewPanel.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  DOM.previewDownloadBtn.href = `/api/files/${fileId}/dl`;
  DOM.previewDownloadBtn.setAttribute('download', filename);

  try {
    const mime = mimeType || '';

    // Resim
    if (mime.startsWith('image/')) {
      DOM.previewContent.innerHTML = `
        <a href="/api/files/${fileId}/dl" target="_blank" rel="noopener" title="Tam çözünürlük aç">
          <img src="/api/files/${fileId}/dl" alt="${escapeHtml(filename)}"
            onerror="this.parentElement.outerHTML='<p class=\\'text-muted\\'>Resim yüklenemedi.</p>'"
          >
        </a>
        <p class="text-muted text-xs mt-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:3px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Tam çözünürlük için resme tıkla</p>
      `;
      return;
    }

    // Video
    if (mime.startsWith('video/')) {
      DOM.previewContent.innerHTML = `
        <video controls>
          <source src="/api/files/${fileId}/dl" type="${escapeHtml(mime)}">
          Tarayıcınız video oynatmayı desteklemiyor.
        </video>
      `;
      return;
    }

    // Ses
    if (mime.startsWith('audio/')) {
      DOM.previewContent.innerHTML = `
        <div style="padding: 2rem 0;">
          <p class="text-muted text-sm mb-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="vertical-align:middle;margin-right:4px"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            ${escapeHtml(filename)}
          </p>
          <audio controls style="width:100%">
            <source src="/api/files/${fileId}/dl" type="${escapeHtml(mime)}">
            Tarayıcınız ses oynatmayı desteklemiyor.
          </audio>
        </div>
      `;
      return;
    }

    // PDF
    if (mime === 'application/pdf') {
      DOM.previewContent.innerHTML = `
        <iframe src="/api/files/${fileId}/dl" style="width:100%;height:55vh;border:none;border-radius:8px;"></iframe>
      `;
      return;
    }

    // Text / JSON / JS — fetch ile içeriği al
    if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/javascript'
    ) {
      try {
        const resp = await fetch(`/api/files/${fileId}/dl`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const preview = text.length > 100 * 1024
          ? text.substring(0, 100 * 1024) + '\n\n... (dosya çok büyük, ilk 100KB gösteriliyor)'
          : text;
        DOM.previewContent.innerHTML = `<pre>${escapeHtml(preview)}</pre>`;
      } catch (err) {
        DOM.previewContent.innerHTML = `<p class="text-error">İçerik yüklenemedi: ${escapeHtml(err.message)}</p>`;
      }
      return;
    }

    // Desteklenmeyen
    DOM.previewContent.innerHTML = `<p class="text-muted">Bu dosya türü (${escapeHtml(mime)}) için önizleme desteklenmiyor.</p>`;

  } catch (err) {
    console.error('[Session] Önizleme yüklenemedi:', err);
    DOM.previewContent.innerHTML = '<p class="text-error">Önizleme yüklenemedi.</p>';
  }
}

function closePreview() {
  DOM.previewPanel.classList.add('hidden');
  document.body.style.overflow = '';
  // Video/audio durdur
  const media = DOM.previewContent.querySelector('video, audio');
  if (media) media.pause();
}

// Modal kapatma — ✕ butonu, ikinci kapat butonu, overlay dışı, Escape
DOM.previewCloseBtn.addEventListener('click', closePreview);
DOM.previewCloseBtn2.addEventListener('click', closePreview);
DOM.previewPanel.addEventListener('click', (e) => {
  if (e.target === DOM.previewPanel) closePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.previewPanel.classList.contains('hidden')) {
    closePreview();
  }
});

// =========================================================================
// Countdown Timer
// =========================================================================

function startCountdown(itemElement, expireAt) {
  const countdownEl = itemElement.querySelector('.countdown');
  if (!countdownEl) return;

  const update = () => {
    const timeLeft = getTimeLeft(expireAt);
    countdownEl.textContent = timeLeft;

    if (new Date(expireAt) < new Date()) {
      countdownEl.textContent = 'Süresi doldu (silindi)';
      itemElement.classList.add('expired');
      const actions = itemElement.querySelector('.file-item-actions');
      if (actions) {
        actions.innerHTML = `<span class="text-muted text-xs file-item-deleted"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Silindi</span>`;
      }
    }
  };

  update();
  const interval = setInterval(update, 30000);
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
  const svg = (path) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">${path}</svg>`;
  if (!mimeType) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  if (mimeType.startsWith('image/')) return svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
  if (mimeType.startsWith('video/')) return svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>');
  if (mimeType.startsWith('audio/')) return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
  if (mimeType.includes('pdf')) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>');
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip'))
    return svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>');
  if (mimeType.includes('text') || mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml'))
    return svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
  return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
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
