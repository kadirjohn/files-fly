/**
 * session.js — Files Fly Dosyalarım Sayfası JavaScript
 *
 * Kullanıcının kendi yüklediği dosyaları listeler.
 * Session cookie ile otomatik tanımlama.
 * Sayfalama, link kopyalama, indirme, süre sayacı, önizleme.
 */

(function () {
  'use strict';

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

  // app.js'in upload sonrası çağırabilmesi için global olarak expose et.
  // Artık ana liste bundle'ları gösterir (loadBundles); loadFiles eski dosya
  // listesidir ve yalnızca geri uyumluluk için tutulur, ana akışta çağrılmaz.
  window.loadFiles = loadBundles;

  async function loadBundles(page = 1) {
  DOM.loadingState.classList.remove('hidden');
  DOM.emptyState.classList.add('hidden');
  DOM.errorState.classList.add('hidden');
  DOM.fileList.innerHTML = '';
  DOM.pagination.classList.add('hidden');

  countdownIntervals.forEach(clearInterval);
  countdownIntervals = [];

  try {
    dbg.info('session', `GET /api/session/bundles?page=${page}&limit=20`);
    const resp = await fetch(`/api/session/bundles?page=${page}&limit=20`);

    if (!resp.ok) {
      if (resp.status === 401) {
        dbg.warn('session', '401 — session recreating');
        await fetch('/api/session', { method: 'POST' });
        return loadBundles(page);
      }
      dbg.error('session', `HTTP ${resp.status}`);
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    currentPage = data.page;
    totalPages = data.pages;
    dbg.info('session', `✓ Bundles loaded`, { count: data.bundles.length, page: data.page, pages: data.pages });

    DOM.loadingState.classList.add('hidden');

    if (data.bundles.length === 0) {
      dbg.log('session', 'No bundles (empty session)');
      DOM.emptyState.classList.remove('hidden');
      return;
    }

    renderBundleCards(data.bundles);

    if (totalPages > 1) {
      DOM.pagination.classList.remove('hidden');
      DOM.pageInfo.textContent = `${t('sessionPageInfo')} ${currentPage} / ${totalPages}`;
      DOM.prevPageBtn.disabled = currentPage <= 1;
      DOM.nextPageBtn.disabled = currentPage >= totalPages;
    }
  } catch (err) {
    dbg.error('session', 'Bundles loading error', err);
    console.error('[Session] Bundle\'lar yüklenirken hata:', err);
    DOM.loadingState.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
    DOM.errorText.textContent = t('sessionErrorLoad');
  }
}

  // Eski dosya-bazlı liste (GERİ UYUMLU). Ana akış artık bundle kartlarını
  // kullanır; bu fonksiyon altta tutulur ama window.loadFiles'e bağlı değildir.
  async function loadFiles(page = 1) {
  DOM.loadingState.classList.remove('hidden');
  DOM.emptyState.classList.add('hidden');
  DOM.errorState.classList.add('hidden');
  DOM.fileList.innerHTML = '';
  DOM.pagination.classList.add('hidden');

  countdownIntervals.forEach(clearInterval);
  countdownIntervals = [];

  try {
    dbg.info('session', `GET /api/session/files?page=${page}&limit=20`);
    const resp = await fetch(`/api/session/files?page=${page}&limit=20`);

    if (!resp.ok) {
      if (resp.status === 401) {
        dbg.warn('session', '401 — session recreating');
        await fetch('/api/session', { method: 'POST' });
        return loadFiles(page);
      }
      dbg.error('session', `HTTP ${resp.status}`);
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    currentPage = data.page;
    totalPages = data.pages;
    dbg.info('session', `✓ Files loaded`, { count: data.files.length, page: data.page, pages: data.pages });

    DOM.loadingState.classList.add('hidden');

    if (data.files.length === 0) {
      dbg.log('session', 'No files (empty session)');
      DOM.emptyState.classList.remove('hidden');
      return;
    }

    renderFiles(data.files);

    if (totalPages > 1) {
      DOM.pagination.classList.remove('hidden');
      DOM.pageInfo.textContent = `${t('sessionPageInfo')} ${currentPage} / ${totalPages}`;
      DOM.prevPageBtn.disabled = currentPage <= 1;
      DOM.nextPageBtn.disabled = currentPage >= totalPages;
    }
  } catch (err) {
    dbg.error('session', 'Files loading error', err);
    console.error('[Session] Dosyalar yüklenirken hata:', err);
    DOM.loadingState.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
    DOM.errorText.textContent = t('sessionErrorLoad');
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

    const size = formatSize(file.file_size);
    const timeLeft = expired ? t('sessionExpired') : getTimeLeft(file.expire_at);
    const isEncrypted = !!file.is_encrypted;
    const isImage = file.mime_type && file.mime_type.startsWith('image/');
    // Şifreli dosyaların ham /dl'i ciphertext döndürür — inline preview anlamsız.
    // Şifreli dosyalar için /files/:id önizleme sayfası (parola gate) açılır.
    const isPreviewable = !expired && !isEncrypted && (
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

    // Paylaşım linki: önizleme sayfası (şifreli dosyalar için parola gate burada açılır).
    // Şifresiz dosyalar için de tutarlılık adına /files/:id kullanılır (preview page).
    const previewPageUrl = `${window.location.origin}/files/${file.id}`;
    // Doğrudan indirme linki (şifresiz dosyalar için hızlı indirme).
    const directUrl = file.direct_url
      ? (file.direct_url.startsWith('http') ? file.direct_url : window.location.origin + file.direct_url)
      : null;
    // Kopyalanacak/paylaşılacak link → önizleme sayfası (parola gate tutarlılığı).
    const shareUrl = previewPageUrl;

    // Set data attributes for event delegation
    if (isPreviewable) {
      item.dataset.previewId = file.id;
      item.dataset.previewName = file.filename;
      item.dataset.previewMime = file.mime_type;
      item.classList.add('row-clickable');
    }

    // Build icon area: şifreli image'lar için raw thumbnail anlamsızdır → ikon göster.
    // Şifresiz image'lar için compressed thumbnail (/thumb) kullan — full res /dl'de.
    let iconHtml;
    if (isImage && !expired && !isEncrypted) {
      iconHtml = `<img src="/api/files/${file.id}/thumb" alt="" loading="lazy" class="file-item-thumb" data-fallback-icon="${escapeAttr(file.mime_type)}" data-fallback-dl="/api/files/${file.id}/dl">`;
    } else {
      iconHtml = `<span class="file-item-icon">${getFileIcon(file.mime_type, file.filename)}</span>`;
    }

    // Şifreli rozet
    const lockBadge = isEncrypted
      ? `<span class="encrypted-lock-badge" title="${currentLang === 'en' ? 'Password protected' : 'Parola korumalı'}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>`
      : '';

    item.innerHTML = `
      ${iconHtml}
      <div class="file-item-info">
        <div class="file-item-name">${escapeHtml(file.filename)} ${lockBadge}</div>
        <div class="file-item-meta-badges">
          <span class="meta-badge meta-badge-size">${size}</span>
          <span class="meta-badge meta-badge-time">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span class="countdown" data-expire="${file.expire_at}">${timeLeft}</span>
          </span>
          ${file.download_count > 0 ? `<span class="text-xs text-muted">${file.download_count} ${currentLang === 'en' ? 'downloads' : 'indirme'}</span>` : ''}
        </div>
      </div>
      <div class="file-item-actions">
        ${!expired ? `
          <button class="btn btn-copy btn-sm copy-link-btn" data-url="${escapeAttr(shareUrl || '')}" title="${t('copyBtn')}" aria-label="${t('copyBtn')}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </button>
          <a href="${escapeAttr(previewPageUrl)}" class="btn btn-success btn-sm btn-icon-only" title="${isEncrypted ? t('sessionDownloadEncrypted') : t('sessionDownloadFile')}" aria-label="${isEncrypted ? t('sessionDownloadEncrypted') : t('sessionDownloadFile')}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
        ` : `
          <span class="text-muted text-xs file-item-deleted">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            ${t('sessionDeleted')}
          </span>
        `}
      </div>
    `;

    // Fix image fallback without onerror inline script
    // Thumbnail (/thumb) yüklenemezse önce full /dl'yi dene, o da olmazsa ikon göster.
    const img = item.querySelector('img.file-item-thumb');
    if (img) {
      img.addEventListener('error', () => {
        const dlFallback = img.dataset.fallbackDl;
        const currentSrc = img.getAttribute('src') || '';
        if (dlFallback && currentSrc !== dlFallback) {
          // Önce compressed thumbnail → full /dl'ye düş
          img.setAttribute('src', dlFallback);
          return;
        }
        const mime = img.dataset.fallbackIcon || '';
        const span = document.createElement('span');
        span.className = 'file-item-icon';
        span.innerHTML = getFileIcon(mime, file.filename);
        img.replaceWith(span);
      });
    }

    DOM.fileList.appendChild(item);

    if (!expired) {
      startCountdown(item, file.expire_at);
    }
  }

  // Link kopyalama (icon-only buton — text label yok)
  document.querySelectorAll('.copy-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // file-item click'i tetiklemesin
      const url = btn.dataset.url;
      copyToClipboard(url);
      const svgEl = btn.querySelector('svg');
      if (svgEl) svgEl.classList.add('icon-success');
      btn.classList.add('btn-copied');
      // Brief visual feedback: kopyalandı checkmark
      const origHtml = svgEl ? svgEl.outerHTML : '';
      if (svgEl) {
        svgEl.outerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" class="icon-success"><polyline points="20 6 9 17 4 12"/></svg>';
      }
      setTimeout(() => {
        const newSvg = btn.querySelector('svg');
        if (newSvg) newSvg.outerHTML = origHtml;
        btn.classList.remove('btn-copied');
      }, 2000);
    });
  });

  // İndir butonunun file-item click'i tetiklememesi
  document.querySelectorAll('.file-item a.btn-success, .file-item a.btn-primary').forEach(a => {
    a.addEventListener('click', (e) => e.stopPropagation());
  });

  // File item'a tıklayınca önizleme aç (previewable olan item'larda)
  document.querySelectorAll('.file-item[data-preview-id]').forEach(item => {
    item.addEventListener('click', () => {
      openPreview(item.dataset.previewId, item.dataset.previewName, item.dataset.previewMime);
    });
  });
}

// =========================================================================
// Bundle Kartları (Dosyalarım — bundle bazlı)
// =========================================================================
// /api/session/bundles her bundle için {id,title,file_count,total_size,
// expire_at,is_encrypted,created_at} döndürür — dosya listesi YOK. Karttaki
// thumbnail'ler için her bundle'a ayrı GET /api/bundles/:id (dosya listesi)
// yapılır; ilk 4 image dosyasının /thumb'u gösterilir. Şifreli bundle'lar için
// raw /thumb ciphertext döner → thumbnail yerine ikon göster. N+1 kabul edilir
// (plan notu). Kopyala → /b/:id linki; Önizle → /b/:id (receiver); Sil →
// confirm → DELETE /api/bundles/:id → yeniden yükle.

const BUNDLE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

function renderBundleCards(bundles) {
  DOM.fileList.innerHTML = '';

  for (const b of bundles) {
    const expired = new Date(b.expire_at) < new Date();
    const isEncrypted = !!b.is_encrypted;
    const timeLeft = expired ? t('sessionExpired') : getTimeLeft(b.expire_at);
    const shareUrl = `${window.location.origin}/b/${b.id}`;
    const titleText = b.title || (b.file_count + ' ' + t('bundleFiles'));

    const card = document.createElement('div');
    card.className = `bundle-card${expired ? ' expired' : ''}`;
    card.dataset.bundle = b.id;
    card.innerHTML = `
      <div class="bundle-card-top">
        <span class="bundle-card-icon">${BUNDLE_ICON_SVG}</span>
        <div class="bundle-card-info">
          <div class="bundle-card-title">
            ${escapeHtml(titleText)}
            ${isEncrypted ? `<span class="encrypted-lock-badge" title="${t('bundlePasswordProtected')}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>` : ''}
          </div>
          <div class="bundle-card-count">
            <span class="meta-badge meta-badge-size">${b.file_count} ${t('bundleFiles')} · ${formatSize(b.total_size)}</span>
            <span class="meta-badge meta-badge-time">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span class="countdown" data-expire="${b.expire_at}">${timeLeft}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="bundle-card-thumbs" data-bundle="${b.id}"></div>
      <div class="bundle-card-bottom">
        <div class="bundle-card-actions">
          ${!expired ? `
            <button class="btn btn-copy btn-sm copy-link-btn" data-url="${escapeAttr(shareUrl)}" title="${t('trayCopyLink')}" aria-label="${t('trayCopyLink')}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <a class="btn btn-ghost btn-sm" href="/b/${b.id}" target="_blank" rel="noopener" title="${t('bundlePreview')}" aria-label="${t('bundlePreview')}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </a>
            <button class="btn btn-danger btn-sm bundle-delete-btn" data-delete="${b.id}" title="${t('bundleDelete')}" aria-label="${t('bundleDelete')}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          ` : `
            <span class="text-muted text-xs file-item-deleted">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              ${t('sessionDeleted')}
            </span>
          `}
        </div>
      </div>
    `;

    DOM.fileList.appendChild(card);

    if (!expired) {
      startCountdown(card, b.expire_at);
      // Thumbnail'leri async yükle (kart DOM'a eklendikten sonra).
      loadBundleThumbs(card.querySelector('.bundle-card-thumbs'), b.id, isEncrypted);
    }
  }

  // Kopyala butonları (renderFiles ile aynı görsel feedback).
  document.querySelectorAll('.bundle-card .copy-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(btn.dataset.url);
      const svgEl = btn.querySelector('svg');
      const origHtml = svgEl ? svgEl.outerHTML : '';
      if (svgEl) {
        svgEl.outerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" class="icon-success"><polyline points="20 6 9 17 4 12"/></svg>';
        btn.classList.add('btn-copied');
      }
      setTimeout(() => {
        const newSvg = btn.querySelector('svg');
        if (newSvg) newSvg.outerHTML = origHtml;
        btn.classList.remove('btn-copied');
      }, 2000);
    });
  });

  // Önizle/indir linki kart click'ini tetiklemesin.
  document.querySelectorAll('.bundle-card a.btn-ghost').forEach(a => {
    a.addEventListener('click', (e) => e.stopPropagation());
  });

  // Sil butonları → confirm → DELETE → yeniden yükle.
  document.querySelectorAll('.bundle-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      if (!confirm(t('bundleDeleteConfirm'))) return;
      btn.disabled = true;
      try {
        const resp = await fetch('/api/bundles/' + id, { method: 'DELETE' });
        if (resp.status === 401) {
          await fetch('/api/session', { method: 'POST' });
          const retry = await fetch('/api/bundles/' + id, { method: 'DELETE' });
          if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        } else if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const card = btn.closest('.bundle-card');
        if (card) {
          card.style.transition = 'opacity .2s';
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 200);
        }
        // Liste tamamen boşaldıysa boş-durum göster.
        if (!DOM.fileList.children.length) {
          DOM.emptyState.classList.remove('hidden');
        }
      } catch (err) {
        dbg.error('session', 'bundle delete error', err);
        btn.disabled = false;
        alert(t('sessionErrorLoadShort'));
      }
    });
  });
}

// Bir bundle'ın ilk 4 image dosyası için /thumb göster. Şifreli bundle →
// thumbnail anlamsız (ciphertext) → sadece ikon bırakırız. Dosya listesini
// GET /api/bundles/:id'den alırız (receiver metadata).
async function loadBundleThumbs(thumbContainer, bundleId, isEncrypted) {
  if (!thumbContainer) return;
  if (isEncrypted) {
    // Şifreli bundle: thumbnail yok → kilidi temsil eden tek ikon.
    thumbContainer.innerHTML = `<span class="bundle-thumb-placeholder"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>`;
    return;
  }
  try {
    const resp = await fetch('/api/bundles/' + bundleId);
    if (!resp.ok) return;
    const data = await resp.json();
    const images = (data.files || []).filter(f => f.mime_type && f.mime_type.startsWith('image/')).slice(0, 4);
    if (!images.length) {
      thumbContainer.innerHTML = `<span class="bundle-thumb-placeholder">${BUNDLE_ICON_SVG}</span>`;
      return;
    }
    thumbContainer.innerHTML = images.map(f =>
      `<img src="/api/files/${f.id}/thumb" alt="" loading="lazy" class="bundle-thumb" data-id="${f.id}">`
    ).join('');
    // Thumbnail yüklenemezse gizle (yer tutucu kalsın).
    thumbContainer.querySelectorAll('img.bundle-thumb').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  } catch (err) {
    dbg.error('session', 'bundle thumbs error', err);
  }
}

// =========================================================================
// Önizleme
// =========================================================================

async function openPreview(fileId, filename, mimeType) {
  // Keep the SVG icon in the title
  const titleIcon = DOM.previewTitle.querySelector('svg');
  const titleIconHtml = titleIcon ? titleIcon.outerHTML : '';
  if (titleIconHtml) {
    DOM.previewTitle.innerHTML = titleIconHtml + ` ${t('sessionPreviewFile')} ${escapeHtml(filename)}`;
  } else {
    DOM.previewTitle.textContent = `${t('sessionPreviewFile')} ${filename}`;
  }
  DOM.previewContent.innerHTML = `<p class="text-muted text-sm">${t('sessionPreviewLoading')}</p>`;
  DOM.previewPanel.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  DOM.previewDownloadBtn.href = `/api/files/${fileId}/dl`;
  DOM.previewDownloadBtn.setAttribute('download', filename);

  try {
    const mime = mimeType || '';

    // Resim — preview için compressed thumbnail (/thumb), tam çözünürlük için /dl
    if (mime.startsWith('image/')) {
      DOM.previewContent.innerHTML = `
        <a href="/api/files/${fileId}/dl" target="_blank" rel="noopener" title="${t('sessionPreviewFullRes')}" class="preview-img-link">
          <img src="/api/files/${fileId}/thumb" alt="${escapeHtml(filename)}" class="preview-thumb-img"
            data-fallback="/api/files/${fileId}/dl"
          >
        </a>
        <p class="text-muted text-xs mt-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:3px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ${currentLang === 'en' ? 'Click image for full resolution' : 'Tam çözünürlük için resme tıkla'}</p>
      `;
      // Thumbnail yüklenemezse full /dl'ye düş
      const thumbImg = DOM.previewContent.querySelector('img.preview-thumb-img');
      if (thumbImg) {
        thumbImg.addEventListener('error', () => {
          const fb = thumbImg.dataset.fallback;
          if (fb && thumbImg.getAttribute('src') !== fb) {
            thumbImg.setAttribute('src', fb);
          } else {
            thumbImg.parentElement.outerHTML = `<p class="text-muted">${currentLang === 'en' ? 'Image could not be loaded.' : 'Resim yüklenemedi.'}</p>`;
          }
        });
      }
      return;
    }

    // Video
    if (mime.startsWith('video/')) {
      DOM.previewContent.innerHTML = `
        <video controls>
          <source src="/api/files/${fileId}/dl" type="${escapeHtml(mime)}">
          ${currentLang === 'en' ? 'Your browser does not support video playback.' : 'Tarayıcınız video oynatmayı desteklemiyor.'}
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
            ${currentLang === 'en' ? 'Your browser does not support audio playback.' : 'Tarayıcınız ses oynatmayı desteklemiyor.'}
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
          ? text.substring(0, 100 * 1024) + (currentLang === 'en' ? '\n\n... (file too large, showing first 100KB)' : '\n\n... (dosya çok büyük, ilk 100KB gösteriliyor)')
          : text;
        DOM.previewContent.innerHTML = `<pre>${escapeHtml(preview)}</pre>`;
      } catch (err) {
        DOM.previewContent.innerHTML = `<p class="text-error">${t('sessionPreviewContentError')} ${escapeHtml(err.message)}</p>`;
      }
      return;
    }

    // Desteklenmeyen
    DOM.previewContent.innerHTML = `<p class="text-muted">${t('sessionPreviewUnsupported')} (${escapeHtml(mime)})</p>`;

  } catch (err) {
    console.error('[Session] Önizleme yüklenemedi:', err);
    DOM.previewContent.innerHTML = `<p class="text-error">${t('sessionPreviewLoadError')}</p>`;
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
      countdownEl.textContent = t('sessionExpired');
      itemElement.classList.add('expired');
      // Remove preview capability
      delete itemElement.dataset.previewId;
      itemElement.classList.remove('row-clickable');
      const actions = itemElement.querySelector('.file-item-actions');
      if (actions) {
        actions.innerHTML = `<span class="text-muted text-xs file-item-deleted"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> ${t('sessionDeleted')}</span>`;
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

  if (diffMs <= 0) return t('sessionExpired');

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const isEn = currentLang === 'en';

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return isEn
      ? `${days}d ${hours % 24}h left`
      : `${days} gün ${hours % 24} saat kaldı`;
  }
  if (hours > 0) {
    return isEn
      ? `${hours}h ${minutes}m left`
      : `${hours} saat ${minutes} dk kaldı`;
  }
  return isEn
    ? `${minutes}m left`
    : `${minutes} dk kaldı`;
}

// =========================================================================
// Sayfalama
// =========================================================================

DOM.prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    loadBundles(currentPage - 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

DOM.nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages) {
    loadBundles(currentPage + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

DOM.retryLoadBtn.addEventListener('click', () => loadBundles(currentPage));

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

// Attribute değerlerinde kullanmak için (özellikle data-* ve href)
function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    loadBundles();
  });

})();
