// public/js/bundle.js — Bundle receiver page logic.
//
// URL: /b/:bundleId
// Akış:
//   1. URL'den bundleId çıkar
//   2. GET /api/bundles/:id → metadata + dosya listesi
//   3. Şifreliyse parola gate → her dosyayı tek tek client-side deşifre et,
//      blob URL'leri cache'le. Şifresizse direkt dosya listesi.
//   4. Dosya listesi: checkbox + önizle + indir. Tek dosya → inline preview.
//   5. "Hepsini indir": şifresizse server-side zip (POST /api/bundles/:id/download),
//      şifreliyse her dosyayı tek tek indir (zip server-side şifreli desteklemiyor).
//   6. "Seçilenleri indir": seçili alt-küme → zip (yalnız şifresiz).
(function () {
  'use strict';

  const idFromUrl = () => decodeURIComponent(location.pathname.split('/').pop() || '');
  const bundleId = idFromUrl();
  const D = (id) => document.getElementById(id);

  // i18n — app.js ile aynı t() (bundle.html i18n.js'i yükler). Dil localStorage'dan
  // veya <html lang>'den; yoksa 'tr'. I18N yoksa (i18n.js yüklenmediyse) key'i döndür.
  const currentLang = (typeof I18N !== 'undefined' && (localStorage.getItem('filesfly_lang') || (document.documentElement.lang === 'en' ? 'en' : 'tr'))) || 'tr';
  function t(key) {
    if (typeof I18N === 'undefined') return key;
    return (I18N[currentLang] && I18N[currentLang][key]) || I18N.tr[key] || key;
  }

  const dom = {
    loading: D('loading'),
    error: D('error-state'),
    errorTitle: D('error-title'),
    errorMsg: D('error-message'),
    info: D('bundle-info'),
    title: D('bundle-title'),
    meta: D('bundle-meta'),
    countdown: D('countdown'),
    encBadge: D('encrypted-badge'),
    selectAll: D('select-all'),
    dlSelected: D('download-selected'),
    dlAll: D('download-all'),
    list: D('file-list'),
    gate: D('password-gate'),
    gatePass: D('gate-password'),
    gateToggle: D('gate-toggle'),
    gateErr: D('gate-error'),
    gateSubmit: D('gate-submit'),
    preview: D('preview-panel'),
    previewTitle: D('preview-title'),
    previewClose: D('preview-close'),
    previewContent: D('preview-content'),
  };

  let bundle = null;
  let decrypted = {};   // fileId -> blob URL (parola gate sonrası)
  let countdownTimer = null;

  // =========================================================================
  // Yükle
  // =========================================================================
  load();

  async function load() {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bundleId)) {
      return showError(t('bundleInvalidLink'), t('bundleInvalidLinkDesc'));
    }
    try {
      dbg.info('bundle', `GET /api/bundles/${bundleId}`);
      const r = await fetch('/api/bundles/' + bundleId);
      if (r.status === 410) return showError(t('bundleExpired'), t('bundleExpiredDesc'));
      if (r.status === 404) return showError(t('bundleNotFound'), t('bundleNotFoundDesc'));
      if (!r.ok) return showError(t('bundleServerError'), 'HTTP ' + r.status + '.');
      bundle = await r.json();
      dbg.info('bundle', 'metadata received', { files: bundle.files.length, encrypted: bundle.is_encrypted });
      render();
    } catch (e) {
      dbg.error('bundle', 'load error', e);
      showError(t('bundleConnectionError'), t('bundleConnectionErrorDesc'));
    }
  }

  // =========================================================================
  // Render
  // =========================================================================
  function render() {
    dom.loading.classList.add('hidden');
    if (bundle.is_encrypted) {
      dom.gate.classList.remove('hidden');
      setTimeout(() => dom.gatePass.focus(), 50);
      return;
    }
    showFiles();
  }

  function showFiles() {
    dom.gate.classList.add('hidden');
    dom.info.classList.remove('hidden');
    dom.title.textContent = bundle.title || (bundle.file_count + ' dosya');
    dom.meta.textContent = bundle.file_count + ' dosya · ' + formatSize(bundle.total_size);
    if (bundle.is_encrypted) dom.encBadge.classList.remove('hidden');
    startCountdown();

    // Tek dosya → detay görünümü (büyük inline preview + indir).
    const single = bundle.files.length === 1;
    dom.list.innerHTML = '';
    dom.list.classList.toggle('single', single);

    bundle.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'bundle-file-row';
      row.innerHTML =
        '<input type="checkbox" class="file-check" data-id="' + f.id + '">' +
        '<span class="file-icon" data-mime="' + esc(f.mime_type || '') + '">' + fileIconSvg(f.mime_type) + '</span>' +
        '<span class="file-name" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span>' +
        '<span class="file-size">' + formatSize(f.file_size) + '</span>' +
        '<button class="btn btn-ghost btn-sm file-preview" data-id="' + f.id + '">' + t('bundlePreview') + '</button>' +
        '<button class="btn btn-ghost btn-sm file-download" data-id="' + f.id + '">' + t('bundleDownload') + '</button>';
      dom.list.appendChild(row);
    });

    // Events
    dom.list.querySelectorAll('.file-preview').forEach((b) => b.addEventListener('click', () => openPreview(b.dataset.id)));
    dom.list.querySelectorAll('.file-download').forEach((b) => b.addEventListener('click', () => downloadOne(b.dataset.id)));
    dom.list.querySelectorAll('.file-check').forEach((c) => c.addEventListener('change', updateSelected));

    dom.selectAll.onchange = (e) => {
      dom.list.querySelectorAll('.file-check').forEach((c) => { c.checked = e.target.checked; });
      updateSelected();
    };

    // Şifreli: zip desteklenmez → tek tek indir. Seçilenler butonu kapalı.
    if (bundle.is_encrypted) {
      dom.dlAll.textContent = t('bundleDownloadAllIndividually');
      dom.dlSelected.disabled = true;
    }
    dom.dlAll.addEventListener('click', () => (bundle.is_encrypted ? downloadAllIndividually() : downloadZip(null)));
    dom.dlSelected.addEventListener('click', () => downloadZip(selectedIds()));

    // Tek dosyalık bundle → preview'ı otomatik aç.
    if (single && bundle.files[0]) openPreview(bundle.files[0].id);

    updateSelected();
  }

  // =========================================================================
  // Önizleme modalı
  // =========================================================================
  function openPreview(fileId) {
    const f = bundle.files.find((x) => x.id === fileId);
    if (!f) return;
    dom.previewTitle.textContent = f.filename;
    dom.previewContent.innerHTML = '';
    FFPreview.render(dom.previewContent, {
      fileId: f.id, filename: f.filename, mimeType: f.mime_type,
      isEncrypted: !!f.is_encrypted, decryptedBlobUrl: decrypted[f.id] || null,
    });
    dom.preview.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closePreview() {
    FFPreview.stop(dom.previewContent);
    dom.preview.classList.add('hidden');
    document.body.style.overflow = '';
  }
  dom.previewClose.addEventListener('click', closePreview);
  dom.preview.addEventListener('click', (e) => { if (e.target === dom.preview) closePreview(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.preview.classList.contains('hidden')) closePreview();
  });

  // =========================================================================
  // İndirme
  // =========================================================================
  function downloadOne(fileId) {
    const f = bundle.files.find((x) => x.id === fileId);
    if (!f) return;
    if (f.is_encrypted && decrypted[fileId]) {
      triggerDownload(decrypted[fileId], f.filename);
      return;
    }
    if (f.is_encrypted) {
      // Henüz deşifre edilmedi → parola gate'i aç, çözüldükten sonra bu dosyayı indir.
      dom.gate.classList.remove('hidden');
      dom.gate._pendingFile = fileId;
      setTimeout(() => dom.gatePass.focus(), 50);
      return;
    }
    window.location.href = '/api/files/' + fileId + '/dl';
  }

  async function downloadZip(ids) {
    const body = ids && ids.length ? JSON.stringify({ file_ids: ids }) : '{}';
    try {
      const r = await fetch('/api/bundles/' + bundleId + '/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) {
        alert(t('bundleZipFailed') + ' (HTTP ' + r.status + ').');
        return;
      }
      const buf = await r.blob();
      const url = URL.createObjectURL(buf);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bundle-' + bundleId.slice(0, 8) + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(t('bundleZipFailed') + ': ' + e.message);
    }
  }

  async function downloadAllIndividually() {
    for (const f of bundle.files) {
      if (f.is_encrypted && decrypted[f.id]) triggerDownload(decrypted[f.id], f.filename);
      else if (!f.is_encrypted) window.open('/api/files/' + f.id + '/dl', '_blank', 'noopener');
    }
  }

  function selectedIds() {
    return [...dom.list.querySelectorAll('.file-check:checked')].map((c) => c.dataset.id);
  }
  function updateSelected() {
    const ids = selectedIds();
    dom.dlSelected.disabled = ids.length === 0 || bundle.is_encrypted;
    dom.dlSelected.textContent = t('bundleDownloadSelected') + ' (' + ids.length + ')';
  }

  // =========================================================================
  // Parola Gate (şifreli bundle'lar)
  // =========================================================================
  dom.gateToggle.addEventListener('click', () => {
    const i = dom.gatePass;
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  dom.gatePass.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.gateSubmit.click(); });

  dom.gateSubmit.addEventListener('click', async () => {
    dom.gateErr.classList.add('hidden');
    const pw = dom.gatePass.value;
    if (!pw) {
      dom.gateErr.textContent = t('bundlePasswordEmpty');
      dom.gateErr.classList.remove('hidden');
      return;
    }
    dom.gateSubmit.disabled = true;
    try {
      for (const f of bundle.files) {
        if (!f.is_encrypted) continue;
        const r = await fetch('/api/files/' + f.id + '/dl');
        if (!r.ok) throw new Error('Dosya alınamadı (HTTP ' + r.status + ').');
        const ct = await r.arrayBuffer();
        // Bundle şifrelemesi: tek parola, bundle-level paylaşımlı salt (server-side
        // selectDecryptSalt). Her dosya kendi IV'sini kullanır.
        const salt = f.encryption_salt;
        const plain = await FFCrypto.decryptFile(ct, f.encryption_iv, salt, pw);
        const blob = new Blob([plain], { type: f.mime_type || 'application/octet-stream' });
        if (decrypted[f.id]) URL.revokeObjectURL(decrypted[f.id]);
        decrypted[f.id] = URL.createObjectURL(blob);
      }
      dom.gateSubmit.disabled = false;
      showFiles();
      if (dom.gate._pendingFile) {
        downloadOne(dom.gate._pendingFile);
        delete dom.gate._pendingFile;
      }
    } catch (e) {
      dom.gateSubmit.disabled = false;
      dbg.error('bundle', 'decrypt error', e);
      dom.gateErr.textContent = t('bundlePasswordWrong');
      dom.gateErr.classList.remove('hidden');
    }
  });

  // =========================================================================
  // Süre sayacı
  // =========================================================================
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    const upd = () => {
      const left = new Date(bundle.expire_at) - new Date();
      if (left <= 0) {
        dom.countdown.textContent = t('bundleCountdownExpired');
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        return;
      }
      const mins = Math.floor(left / 60000);
      const hrs = Math.floor(mins / 60);
      const hrLabel = currentLang === 'en' ? 'h' : 'sa';
      const minLabel = currentLang === 'en' ? 'm' : 'dk';
      const leftLabel = currentLang === 'en' ? 'left' : 'kaldı';
      dom.countdown.textContent = hrs > 0
        ? hrs + ' ' + hrLabel + ' ' + (mins % 60) + ' ' + minLabel + ' ' + leftLabel
        : mins + ' ' + minLabel + ' ' + leftLabel;
    };
    upd();
    countdownTimer = setInterval(upd, 30000);
  }

  // =========================================================================
  // Hata + yardımcılar
  // =========================================================================
  function showError(title, msg) {
    dom.loading.classList.add('hidden');
    dom.error.classList.remove('hidden');
    dom.errorTitle.textContent = title;
    dom.errorMsg.textContent = msg || '';
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatSize(b) {
    b = Number(b) || 0;
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'dosya';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function fileIconSvg(mimeType) {
    const svg = (p) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">' + p + '</svg>';
    if (!mimeType) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
    if (mimeType.startsWith('image/')) return svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
    if (mimeType.startsWith('video/')) return svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>');
    if (mimeType.startsWith('audio/')) return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
    if (mimeType.includes('pdf')) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>');
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>');
    if (mimeType.startsWith('text/')) return svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
    return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  }
})();
