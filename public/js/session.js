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

    const isSingle = b.file_count === 1;
    const card = document.createElement('div');
    card.className = `bundle-card${expired ? ' expired' : ''}${isSingle ? ' single' : ''}`;
    card.dataset.bundle = b.id;

    if (isSingle) {
      // Tek dosya: yatay compact — thumb/ikon sol, ad+boyut+süre orta,
      // sağda İndir + Sil (kopyala yok). Karta basınca preview açılır.
      // Dosya adı/mime async gelir (loadSingleFileCard); önce iskelet.
      card.innerHTML = `
        <div class="bundle-card-single">
          <span class="bundle-card-single-icon"></span>
          <div class="bundle-card-single-info">
            <div class="bundle-card-title bundle-card-single-name" data-file-name></div>
            <div class="bundle-card-count">
              <span class="meta-badge meta-badge-size" data-file-meta></span>
              <span class="meta-badge meta-badge-time">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span class="countdown" data-expire="${b.expire_at}">${timeLeft}</span>
              </span>
            </div>
          </div>
          <div class="bundle-card-single-actions">
            ${!expired ? `
              <button class="btn btn-ghost btn-sm bundle-single-download" data-bundle="${b.id}" title="${t('bundleDownload')}" aria-label="${t('bundleDownload')}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="btn btn-danger btn-sm bundle-delete-btn" data-delete="${b.id}" title="${t('bundleDelete')}" aria-label="${t('bundleDelete')}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>
            ` : `<span class="text-muted text-xs file-item-deleted">${t('sessionDeleted')}</span>`}
          </div>
        </div>
      `;
    } else {
      // Çok dosyalı bundle: mevcut kart + 4'lü thumb ızgara. Karta basınca modal.
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
          <div class="bundle-card-actions bundle-card-actions-inline">
            ${!expired ? `
              <button class="btn btn-copy btn-sm copy-link-btn" data-url="${escapeAttr(shareUrl)}" title="${t('trayCopyLink')}" aria-label="${t('trayCopyLink')}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
              <button class="btn btn-danger btn-sm bundle-delete-btn" data-delete="${b.id}" title="${t('bundleDelete')}" aria-label="${t('bundleDelete')}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>
            ` : `<span class="text-muted text-xs file-item-deleted">${t('sessionDeleted')}</span>`}
          </div>
        </div>
        <div class="bundle-card-thumbs" data-bundle="${b.id}"></div>
      `;
    }

    DOM.fileList.appendChild(card);

    if (!expired) {
      startCountdown(card, b.expire_at);
      if (isSingle) {
        // Tek dosya: ad/ikon/mime async doldur + karta basınca preview.
        loadSingleFileCard(card, b.id, isEncrypted);
        card.addEventListener('click', () => {
          const fid = card.dataset.fileId;
          const fname = card.dataset.fileName;
          const fmime = card.dataset.fileMime;
          if (fid) openPreview(fid, fname || '', fmime || '');
        });
      } else {
        // Çok dosya: thumb'ları yükle + karta basınca modal.
        loadBundleThumbs(card.querySelector('.bundle-card-thumbs'), b.id, isEncrypted);
        card.addEventListener('click', () => openBundleModal(b.id));
      }
    }
  }

  // Kopyala butonları (çok dosyalı kart — renderFiles ile aynı görsel feedback).
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

  // Tek dosya kartı: İndir butonu → blob-fetch + triggerDownload.
  document.querySelectorAll('.bundle-single-download').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = btn.closest('.bundle-card');
      const fid = card && card.dataset.fileId;
      const fname = card && card.dataset.fileName;
      if (!fid) return;
      downloadBundleFile(fid, fname || 'dosya', card && card.dataset.fileEnc === '1');
    });
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

// Tek dosyalık bundle kartını async doldur: ad, ikon, mime, indirme için
// fileId'yi kart dataset'ine kaydet. Şifreli ise image thumb yerine kilit ikonu.
async function loadSingleFileCard(card, bundleId, isEncrypted) {
  try {
    const resp = await fetch('/api/bundles/' + bundleId);
    if (!resp.ok) return;
    const data = await resp.json();
    const f = (data.files || [])[0];
    if (!f) return;
    card.dataset.fileId = f.id;
    card.dataset.fileName = f.filename || '';
    card.dataset.fileMime = f.mime_type || '';
    card.dataset.fileEnc = f.is_encrypted ? '1' : '0';

    const nameEl = card.querySelector('[data-file-name]');
    if (nameEl) nameEl.textContent = f.filename || t('bundleFiles');

    const metaEl = card.querySelector('[data-file-meta]');
    if (metaEl) metaEl.textContent = formatSize(f.file_size);

    const iconWrap = card.querySelector('.bundle-card-single-icon');
    if (iconWrap) {
      const isImg = f.mime_type && f.mime_type.startsWith('image/') && !f.is_encrypted;
      iconWrap.innerHTML = isImg
        ? `<img src="/api/files/${f.id}/thumb" alt="" class="bundle-thumb-single" data-dl="/api/files/${f.id}/dl">`
        : (isEncrypted
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
          : getFileIcon(f.mime_type, f.filename));
      // Image thumb yüklenemezse full /dl'ye düş, o da olmazsa ikon.
      const img = iconWrap.querySelector('img.bundle-thumb-single');
      if (img) img.addEventListener('error', () => {
        const dl = img.dataset.dl;
        if (dl && img.getAttribute('src') !== dl) { img.setAttribute('src', dl); return; }
        iconWrap.innerHTML = getFileIcon(f.mime_type, f.filename);
      });
    }
  } catch (err) {
    dbg.error('session', 'single file card error', err);
  }
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
    // Kart medya-ızgarası 4'lü grid (components.css .bundle-card-thumbs repeat(4,1fr)).
    // İlk 4 image + kalan varsa "+N" rozeti. Image olmayan dosyalar kart thumb'ında
    // gösterilmez (modal açılınca tüm dosyalar ikon+ad olarak listelenir).
    const allFiles = (data.files || []);
    const images = allFiles.filter(f => f.mime_type && f.mime_type.startsWith('image/')).slice(0, 4);
    const imageCount = allFiles.filter(f => f.mime_type && f.mime_type.startsWith('image/')).length;
    const extraCount = imageCount - images.length;
    if (!images.length) {
      thumbContainer.innerHTML = `<span class="bundle-thumb-placeholder">${BUNDLE_ICON_SVG}</span>`;
      return;
    }
    thumbContainer.innerHTML = images.map(f =>
      `<img src="/api/files/${f.id}/thumb" alt="" loading="lazy" class="bundle-thumb" data-id="${f.id}">`
    ).join('');
    // Kalan image'ler için "+N" rozeti.
    if (extraCount > 0) {
      thumbContainer.innerHTML += `<span class="bundle-thumb-more">+${extraCount}</span>`;
    }
    // Thumbnail yüklenemezse gizle (yer tutucu kalsın).
    thumbContainer.querySelectorAll('img.bundle-thumb').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  } catch (err) {
    dbg.error('session', 'bundle thumbs error', err);
  }
}

// =========================================================================
// Unified Modal — /session sayfa içi #preview-panel iki modu paylaşır:
//   1) Tek-dosya önizleme (openPreview) — Dosyalarım'daki tek-dosya kartı tıkı.
//   2) Bundle modalı (openBundleModal) — Dosyalarım'daki bundle kartı tıkı.
//      Liste modu: kart görünümlü thumb ızgarası + köşede hover ile çıkan seç butonu.
//      Önizleme modu: thumb'a tıklayınca aynı modal içinde dosya önizlemesi + Geri.
// bundle.css YÜKLENMEDIĞI için stiller components.css'te (.bundle-modal-*).
// =========================================================================

let currentBundleFiles = []; // modal'daki dosya listesi (downloadBundleFile için)
let currentBundleId = null;
let currentBundleData = null; // tüm bundle meta (is_encrypted, title vb.)
let modalMode = 'closed'; // 'closed' | 'single' | 'bundle-list' | 'bundle-preview'
const selectedFileIds = new Set(); // bundle liste modunda seçili thumb'lar

async function openBundleModal(bundleId) {
  currentBundleId = bundleId;
  selectedFileIds.clear();
  setModalMode('bundle-list');
  setBundleTitle(t('sessionPreviewLoading'));
  DOM.previewContent.innerHTML = `<p class="text-muted text-sm">${t('sessionPreviewLoading')}</p>`;
  DOM.previewPanel.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Bundle modunda tek-dosya indir butonu gizlenir; kendi aksiyon satırımızı çizeriz.
  DOM.previewDownloadBtn.parentElement.style.display = 'none';

  try {
    const resp = await fetch('/api/bundles/' + bundleId);
    if (resp.status === 410) {
      DOM.previewContent.innerHTML = `<p class="text-muted">${t('sessionExpired')}</p>`;
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bundle = await resp.json();
    currentBundleData = bundle;
    currentBundleFiles = bundle.files || [];
    const titleText = bundle.title || (bundle.file_count + ' ' + t('bundleFiles'));
    setBundleTitle(titleText);

    if (!currentBundleFiles.length) {
      DOM.previewContent.innerHTML = `<p class="text-muted">${currentLang === 'en' ? 'No files in this bundle.' : 'Bu bundle\'da dosya yok.'}</p>`;
      return;
    }

    renderBundleFileList(bundle);
  } catch (err) {
    dbg.error('session', 'bundle modal error', err);
    DOM.previewContent.innerHTML = `<p class="text-error">${t('sessionPreviewLoadError')}</p>`;
  }
}

// Bundle modal başlığını SVG ikon + metin olarak set eder.
function setBundleTitle(text) {
  const icon = BUNDLE_ICON_SVG.replace('width="22"', 'width="16"').replace('height="22"', 'height="16"');
  DOM.previewTitle.innerHTML = `${icon} <span style="vertical-align:middle;margin-left:6px">${escapeHtml(text)}</span>`;
}

// Modal modunu takip eder (closePreview ve title/aksiyon satırı yönetimi için).
function setModalMode(mode) {
  modalMode = mode;
}

// Liste modu: kart görünümlü thumb ızgarası + köşede hover ile çıkan seç butonu +
// altta Tümünü seç / Seçilenleri indir (zip). Şifreli bundle → seç/zip kapalı.
function renderBundleFileList(bundle) {
  const isEncrypted = !!bundle.is_encrypted;
  const selBtnSvg = (on) => on
    ? '<svg class="check-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg class="check-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const thumbs = currentBundleFiles.map((f) => {
    const isImg = (f.mime_type || '').startsWith('image/');
    const media = isImg
      ? `<img class="bundle-modal-thumb-media" src="/api/files/${escapeAttr(f.id)}/thumb" data-fallback="/api/files/${escapeAttr(f.id)}/dl" alt="${escapeAttr(f.filename)}" loading="lazy">`
      : `<div class="bundle-modal-thumb-icon">${getFileIcon(f.mime_type, f.filename)}</div>`;
    return `
      <div class="bundle-modal-thumb${isEncrypted ? ' encrypted' : ''}" data-id="${escapeAttr(f.id)}"
           title="${escapeAttr(f.filename)}">
        ${media}
        ${isEncrypted ? '' : `<button class="bundle-modal-select-btn" data-id="${escapeAttr(f.id)}" aria-label="${t('bundleModalSelect')}" title="${t('bundleModalSelect')}">${selBtnSvg(false)}</button>`}
        <div class="bundle-modal-thumb-info">
          <div class="bundle-modal-thumb-name">${escapeHtml(f.filename)}</div>
          <div class="bundle-modal-thumb-size">${formatSize(f.file_size)}</div>
        </div>
      </div>
    `;
  }).join('');

  const selectAll = isEncrypted ? '' :
    `<label class="bundle-modal-selectall"><input type="checkbox" id="bundle-modal-selectall"> ${t('bundleSelectAll')}</label>`;
  const dlSelected = isEncrypted ? '' :
    `<button class="btn btn-primary btn-sm" id="bundle-modal-dlselected" disabled>${t('bundleDownloadSelected')}</button>`;

  DOM.previewContent.innerHTML = `
    <div class="bundle-modal-grid" id="bundle-modal-grid">${thumbs}</div>
    <div class="bundle-modal-actions">
      ${selectAll}
      ${dlSelected}
    </div>
  `;

  const grid = DOM.previewContent.querySelector('#bundle-modal-grid');

  // Thumb medya: image thumbnail yüklenmezse /dl'ye düş (loadBundleThumbs ile aynı patern).
  grid.querySelectorAll('img.bundle-modal-thumb-media').forEach((img) => {
    img.addEventListener('error', () => {
      const fb = img.dataset.fallback;
      if (fb && img.getAttribute('src') !== fb) {
        img.setAttribute('src', fb);
      } else {
        // Hem thumb hem /dl başarısız → dosya ikonuna dön.
        const thumb = img.closest('.bundle-modal-thumb');
        if (thumb) {
          const fid = thumb.dataset.id;
          const f = currentBundleFiles.find((x) => x.id === fid);
          img.outerHTML = `<div class="bundle-modal-thumb-icon">${f ? getFileIcon(f.mime_type, f.filename) : ''}</div>`;
        }
      }
    });
  });

  // Köşe seç butonu → seçimi toggle et + grid'e has-selection işaretle (hepsinde görünür).
  grid.querySelectorAll('.bundle-modal-select-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFileSelection(btn.dataset.id);
    });
  });

  // Thumb'a tıkla → önizleme moduna geç (aynı modal içinde; yeni pencere açmaz).
  grid.querySelectorAll('.bundle-modal-thumb').forEach((thumb) => {
    thumb.addEventListener('click', (e) => {
      // Seç butonuna basıldıysa önizlemeye gitme (yukarıda stopPropagation yeterli).
      if (e.target.closest('.bundle-modal-select-btn')) return;
      const f = currentBundleFiles.find((x) => x.id === thumb.dataset.id);
      if (f) openBundleFilePreview(f);
    });
  });

  // Tümünü seç / Seçilenleri indir senkronu.
  const dlSelBtn = DOM.previewContent.querySelector('#bundle-modal-dlselected');
  const selAll = DOM.previewContent.querySelector('#bundle-modal-selectall');
  if (selAll) selAll.addEventListener('change', () => {
    if (selAll.checked) currentBundleFiles.forEach((f) => selectedFileIds.add(f.id));
    else selectedFileIds.clear();
    syncThumbSelectionState();
    if (dlSelBtn) dlSelBtn.disabled = selectedFileIds.size === 0;
    if (selAll) selAll.checked = currentBundleFiles.length > 0 && selectedFileIds.size === currentBundleFiles.length;
  });
  // Seçilenleri indir → POST /api/bundles/:id/download {file_ids} → zip blob.
  if (dlSelBtn) dlSelBtn.addEventListener('click', async () => {
    const ids = [...selectedFileIds];
    if (!ids.length) return;
    dlSelBtn.disabled = true;
    try {
      const r = await fetch('/api/bundles/' + currentBundleId + '/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: ids }),
      });
      if (!r.ok) { alert(t('bundleZipFailed') + ' (HTTP ' + r.status + ')'); return; }
      const buf = await r.blob();
      const url = URL.createObjectURL(buf);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bundle-' + currentBundleId.slice(0, 8) + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(t('bundleZipFailed') + ': ' + e.message);
    } finally {
      dlSelBtn.disabled = false;
    }
  });

  // Önceki seçimi geri yükle (preview→list Geri dönüşünde seçim korunmalı):
  // thumb'ların selected class'ı + buton svg + has-selection + alt buton state.
  syncThumbSelectionState();
  if (dlSelBtn) dlSelBtn.disabled = selectedFileIds.size === 0;
  if (selAll) selAll.checked = currentBundleFiles.length > 0 && selectedFileIds.size === currentBundleFiles.length;
}

// Bir dosyayı seçime ekle/çıkar; grid'e has-selection işaretle (diğer butonlar görünür).
function toggleFileSelection(fileId) {
  if (selectedFileIds.has(fileId)) selectedFileIds.delete(fileId);
  else selectedFileIds.add(fileId);
  syncThumbSelectionState();
  const dlSelBtn = DOM.previewContent.querySelector('#bundle-modal-dlselected');
  const selAll = DOM.previewContent.querySelector('#bundle-modal-selectall');
  if (dlSelBtn) dlSelBtn.disabled = selectedFileIds.size === 0;
  if (selAll) selAll.checked = currentBundleFiles.length > 0 && selectedFileIds.size === currentBundleFiles.length;
}

// Seçim state'ini thumb'ların görseline yansıtır (selected class + buton svg).
function syncThumbSelectionState() {
  const grid = DOM.previewContent.querySelector('#bundle-modal-grid');
  if (!grid) return;
  grid.classList.toggle('has-selection', selectedFileIds.size > 0);
  const selBtnSvg = (on) => on
    ? '<svg class="check-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg class="check-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  grid.querySelectorAll('.bundle-modal-thumb').forEach((thumb) => {
    const isSel = selectedFileIds.has(thumb.dataset.id);
    thumb.classList.toggle('selected', isSel);
    const btn = thumb.querySelector('.bundle-modal-select-btn');
    if (btn) {
      btn.classList.toggle('selected', isSel);
      btn.innerHTML = selBtnSvg(isSel);
    }
  });
}

// Önizleme modu: thumb'a tıklanınca aynı modal içinde dosyayı render eder.
// Üstte Geri butonu (liste moduna döner). Aksiyon satırında tek-dosya İndir.
function openBundleFilePreview(file) {
  setModalMode('bundle-preview');
  const backLabel = t('bundleModalBack');
  DOM.previewContent.innerHTML = `
    <div class="bundle-modal-topbar">
      <button class="bundle-modal-back" id="bundle-modal-back">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
        ${escapeHtml(backLabel)}
      </button>
    </div>
    <div id="bundle-preview-target"></div>
  `;
  // Geri → liste moduna dön (seçim state'i korunur).
  const backBtn = DOM.previewContent.querySelector('#bundle-modal-back');
  if (backBtn) backBtn.addEventListener('click', () => {
    setModalMode('bundle-list');
    renderBundleFileList(currentBundleData || {});
    setBundleTitle(currentBundleData ? (currentBundleData.title || (currentBundleData.file_count + ' ' + t('bundleFiles'))) : '');
  });

  // İçeriği target'e render et (image/video/audio/pdf/text). Aksiyon satırına İndir koy.
  renderBundlePreviewContent(file);
}

// renderBundlePreviewContent — openPreview'nin dosya-çizim mantığının bundle-preview
// versiyonu (target #bundle-preview-target + tek-dosya İndir butonu aksiyon satırında).
async function renderBundlePreviewContent(file) {
  const target = DOM.previewContent.querySelector('#bundle-preview-target');
  if (!target) return;
  const fileId = file.id;
  const filename = file.filename;
  const mime = file.mime_type || '';

  try {
    if (mime.startsWith('image/')) {
      target.innerHTML = `
        <img src="/api/files/${escapeAttr(fileId)}/dl" alt="${escapeAttr(filename)}" class="preview-thumb-img"
          style="width:100%;max-height:62vh;object-fit:contain;border-radius:var(--radius-md);display:block;margin:0 auto;">
      `;
      const img = target.querySelector('img');
      if (img) img.addEventListener('error', () => {
        target.innerHTML = `<p class="text-muted">${currentLang === 'en' ? 'Image could not be loaded.' : 'Resim yüklenemedi.'}</p>`;
      });
    } else if (mime.startsWith('video/')) {
      target.innerHTML = `
        <video controls preload="metadata" playsinline style="width:100%;max-height:64vh;border-radius:var(--radius-md);display:block;margin:0 auto;">
          <source src="/api/files/${escapeAttr(fileId)}/dl" type="${escapeHtml(mime)}">
          ${currentLang === 'en' ? 'Your browser does not support video playback.' : 'Tarayıcınız video oynatmayı desteklemiyor.'}
        </video>
      `;
    } else if (mime.startsWith('audio/')) {
      target.innerHTML = `
        <div style="padding:1.5rem 0;">
          <p class="text-muted text-sm mb-2">${escapeHtml(filename)}</p>
          <audio controls style="width:100%">
            <source src="/api/files/${escapeAttr(fileId)}/dl" type="${escapeHtml(mime)}">
            ${currentLang === 'en' ? 'Your browser does not support audio playback.' : 'Tarayıcınız ses oynatmayı desteklemiyor.'}
          </audio>
        </div>
      `;
    } else if (mime === 'application/pdf') {
      target.innerHTML = `
        <iframe src="/api/files/${escapeAttr(fileId)}/dl" style="width:100%;height:55vh;border:none;border-radius:8px;"></iframe>
      `;
    } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript') {
      const resp = await fetch(`/api/files/${escapeAttr(fileId)}/dl`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const preview = text.length > 100 * 1024
        ? text.substring(0, 100 * 1024) + (currentLang === 'en' ? '\n\n... (file too large, showing first 100KB)' : '\n\n... (dosya çok büyük, ilk 100KB gösteriliyor)')
        : text;
      target.innerHTML = `<pre style="max-height:60vh;overflow:auto;">${escapeHtml(preview)}</pre>`;
    } else {
      target.innerHTML = `<p class="text-muted">${t('sessionPreviewUnsupported')} (${escapeHtml(mime)})</p>`;
    }
  } catch (err) {
    target.innerHTML = `<p class="text-error">${t('sessionPreviewContentError')} ${escapeHtml(err.message)}</p>`;
  }

  // Aksiyon satırına tek-dosya İndir koy (bundle-preview modunda).
  DOM.previewDownloadBtn.parentElement.style.display = '';
  DOM.previewDownloadBtn.href = `/api/files/${fileId}/dl`;
  DOM.previewDownloadBtn.setAttribute('download', filename);
}

// Tek dosya indir — /api/files/:id/dl Content-Disposition: inline verdiği için
// browser navigasyon/gösterme yapar; biz fetch→blob→triggerDownload ile gerçek
// kaydetmeyi zorlarız. (bundle.js:174-189 ile aynı root-cause fix.)
async function downloadBundleFile(fileId, filename, isEncrypted) {
  if (isEncrypted) {
    // Şifreli dosya client-side decrypt gerektirir; /session modal'ında henüz decrypt
    // akışı yok → kullanıcıyı receiver sayfasına yönlendir.
    showToast(currentLang === 'en' ? 'Encrypted files must be downloaded from the share page.' : 'Şifreli dosyalar paylaşım sayfasından indirilmeli.', 'error');
    return;
  }
  try {
    const r = await fetch('/api/files/' + fileId + '/dl');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.blob();
    const url = URL.createObjectURL(buf);
    triggerDownload(url, filename || 'dosya');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    alert((currentLang === 'en' ? 'Download failed: ' : 'İndirme başarısız: ') + e.message);
  }
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'dosya';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// =========================================================================
// Önizleme
// =========================================================================

async function openPreview(fileId, filename, mimeType) {
  // Single-file mode: Dosyalarım'daki tek-dosya kartı tıkı. Bundle state'i temizle.
  setModalMode('single');
  selectedFileIds.clear();
  currentBundleFiles = [];
  currentBundleId = null;
  currentBundleData = null;
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
  // Tek-dosya modunda aksiyon satırı görünür olmalı (bundle-list gizlemiş olabilir).
  DOM.previewDownloadBtn.parentElement.style.display = '';
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
        <video controls preload="metadata" playsinline style="width:100%;max-height:64vh;border-radius:var(--radius-md);display:block;margin:0 auto;">
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
  // Tek-dosya / bundle-preview aksiyon satırını görünür yap (bundle-list gizlemiş olabilir).
  const actionsRow = DOM.previewDownloadBtn.parentElement;
  if (actionsRow) actionsRow.style.display = '';
  // Tüm modal state'ini temizle (kapatınca eski liste/seçim kalmasın).
  currentBundleFiles = [];
  currentBundleId = null;
  currentBundleData = null;
  selectedFileIds.clear();
  setModalMode('closed');
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
