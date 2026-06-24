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
    dom.title.textContent = bundle.title || (bundle.file_count + ' ' + t('bundleFiles'));
    dom.meta.textContent = bundle.file_count + ' ' + t('bundleFiles') + ' · ' + formatSize(bundle.total_size);
    if (bundle.is_encrypted) dom.encBadge.classList.remove('hidden');
    startCountdown();

    const isEncrypted = !!bundle.is_encrypted;
    const single = bundle.files.length === 1;
    dom.list.innerHTML = '';
    dom.list.classList.toggle('single', single);

    // Köşe seç butonu: check (seçili) / plus (boş). session.js:renderBundleFileList
    // ile aynı svg dili. Şifreli bundle → seç butonu render edilmez (zip yok).
    const selBtnSvg = (on) => on
      ? '<svg class="check-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg class="check-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    // Bir dosyanın medya içeriği: image → compressed /thumb (cache'lenir, aynı anda
    // preview cache'ini ısırır = Bug C çözümü); değilse dosya-tip ikonu. Şifreli
    // image'lerde /thumb ciphertext döner → error → ikona düşer (session.js ile aynı).
    const mediaFor = (f) => {
      const isImg = (f.mime_type || '').startsWith('image/') && !isEncrypted;
      return isImg
        ? '<img class="bundle-recv-thumb-media" src="/api/files/' + f.id + '/thumb" data-fallback="/api/files/' + f.id + '/dl?preview=1" alt="' + esc(f.filename) + '" loading="lazy">'
        : '<div class="bundle-recv-thumb-icon">' + fileIconSvg(f.mime_type) + '</div>';
    };

    if (single) {
      // Tek dosya → ortalanmış büyük kart. Tıkla → önizle. "Hepsini indir" = bu dosya.
      const f = bundle.files[0];
      const card = document.createElement('div');
      card.className = 'bundle-recv-single';
      card.dataset.id = f.id;
      card.title = f.filename;
      card.innerHTML =
        mediaFor(f) +
        '<div class="bundle-recv-single-info">' +
          '<div class="bundle-recv-single-name">' + esc(f.filename) + '</div>' +
          '<div class="bundle-recv-single-size">' + formatSize(f.file_size) + '</div>' +
        '</div>';
      card.addEventListener('click', () => openPreview(f.id));
      dom.list.appendChild(card);
      // Tek image: thumb error → /dl fallback (önizleme değil, kart görseli için).
      const img = card.querySelector('img.bundle-recv-thumb-media');
      if (img) attachThumbFallback(img, f);
    } else {
      // Çoklu → thumb grid. Her kart: medya + köşe seç butonu + ad/boyut.
      // Tıkla → önizle; seç butonu → seçim toggle (stopPropagation).
      const grid = document.createElement('div');
      grid.className = 'bundle-recv-grid';
      grid.id = 'bundle-recv-grid';

      bundle.files.forEach((f) => {
        const thumb = document.createElement('div');
        thumb.className = 'bundle-recv-thumb';
        thumb.dataset.id = f.id;
        thumb.title = f.filename;
        thumb.innerHTML =
          mediaFor(f) +
          (isEncrypted ? '' : '<button class="bundle-recv-select-btn" data-id="' + f.id + '" aria-label="' + t('bundleModalSelect') + '" title="' + t('bundleModalSelect') + '">' + selBtnSvg(false) + '</button>') +
          '<div class="bundle-recv-thumb-info">' +
            '<div class="bundle-recv-thumb-name">' + esc(f.filename) + '</div>' +
            '<div class="bundle-recv-thumb-size">' + formatSize(f.file_size) + '</div>' +
          '</div>';
        grid.appendChild(thumb);
      });
      dom.list.appendChild(grid);

      // Image thumb error → /dl, o da olmazsa ikon. session.js:712-727 patterni.
      grid.querySelectorAll('img.bundle-recv-thumb-media').forEach((img) => {
        const fid = img.closest('.bundle-recv-thumb').dataset.id;
        const f = bundle.files.find((x) => x.id === fid);
        attachThumbFallback(img, f);
      });

      // Köşe seç butonu → seçim toggle + grid'e has-selection işaretle (hepsinde görünür).
      grid.querySelectorAll('.bundle-recv-select-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSelect(btn.dataset.id);
        });
      });

      // Thumb'a tıkla → önizle (seç butonuna basıldıysa gitme).
      grid.querySelectorAll('.bundle-recv-thumb').forEach((thumb) => {
        thumb.addEventListener('click', (e) => {
          if (e.target.closest('.bundle-recv-select-btn')) return;
          openPreview(thumb.dataset.id);
        });
      });

      dom.selectAll.onchange = (e) => {
        if (e.target.checked) bundle.files.forEach((f) => selectedSet.add(f.id));
        else selectedSet.clear();
        syncSelectUI();
      };
    }

    // Şifreli: zip desteklenmez → tek tek indir. Seçilenler butonu kapalı.
    if (bundle.is_encrypted) {
      dom.dlAll.textContent = t('bundleDownloadAllIndividually');
      dom.dlSelected.disabled = true;
    }
    dom.dlAll.addEventListener('click', () => (bundle.is_encrypted ? downloadAllIndividually() : downloadZip(null)));
    dom.dlSelected.addEventListener('click', () => downloadZip(selectedIds()));

    updateSelected();
  }

  // Image thumb yüklenmezse /dl'ye düş, o da olmazsa dosya ikonuna dön.
  // session.js:renderBundleFileList ile aynı patern — receiver'a uyarlandı.
  function attachThumbFallback(img, file) {
    img.addEventListener('error', () => {
      const fb = img.dataset.fallback;
      if (fb && img.getAttribute('src') !== fb) {
        img.setAttribute('src', fb);
      } else {
        const thumb = img.closest('.bundle-recv-thumb, .bundle-recv-single');
        if (thumb) {
          img.outerHTML = '<div class="bundle-recv-thumb-icon">' + fileIconSvg(file && file.mime_type) + '</div>';
        }
      }
    });
  }

  // Seçimi toggle et: selectedSet + ilgili thumb/buton görsel durumunu güncelle.
  const selectedSet = new Set();
  function toggleSelect(fileId) {
    if (selectedSet.has(fileId)) selectedSet.delete(fileId);
    else selectedSet.add(fileId);
    syncSelectUI();
  }

  // Tüm thumb'ların seçili durumunu selectedSet ile senkronla + "Seçilenleri indir" sayacı.
  function syncSelectUI() {
    const grid = dom.list.querySelector('#bundle-recv-grid');
    if (grid) {
      grid.classList.toggle('has-selection', selectedSet.size > 0);
      grid.querySelectorAll('.bundle-recv-thumb').forEach((thumb) => {
        const on = selectedSet.has(thumb.dataset.id);
        thumb.classList.toggle('selected', on);
        const btn = thumb.querySelector('.bundle-recv-select-btn');
        if (btn) btn.classList.toggle('selected', on);
      });
    }
    // select-all checkbox'ı yarı/dolu durumunu yansıt (basit: hepsi seçiliyse dolu).
    const allIds = bundle.files.map((f) => f.id);
    dom.selectAll.checked = allIds.length > 0 && allIds.every((id) => selectedSet.has(id));
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
  async function downloadOne(fileId) {
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
    // Content-Disposition: inline olduğu için window.location.href browser'da
    // navigasyon/gösterme yapar (PDF/video/image'i sayfada açar, indirmez).
    // fetch→blob→triggerDownload ile gerçek kaydetmeyi zorla.
    try {
      // ?preview=1 → cloud backend'te same-origin stream zorlar. fetch→blob için
      // kritik: cross-origin 302 redirect (→ Supabase) sonrası arrayBuffer/blob
      // opaque/CORS kısıtları yüzünden güvenilmez; same-origin stream bundan korur.
      const r = await fetch('/api/files/' + fileId + '/dl?preview=1');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.blob();
      const url = URL.createObjectURL(buf);
      triggerDownload(url, f.filename || 'dosya');
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      alert(t('bundleDownload') + ': ' + e.message);
    }
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
      else if (!f.is_encrypted) await downloadOne(f.id); // blob-fetch + triggerDownload (window.open yerine)
    }
  }

  function selectedIds() {
    // Seçim artık köşe butonlarıyla (selectedSet) yönetiliyor — checkbox değil.
    return [...selectedSet];
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
        // ?preview=1 → cloud backend'te same-origin stream (cross-origin redirect
        // fetch arrayBuffer güvenilmezliğini aşar).
        const r = await fetch('/api/files/' + f.id + '/dl?preview=1');
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
      const hrLabel = t('bundleHourShort');
      const minLabel = t('bundleMinShort');
      const leftLabel = t('bundleTimeLeft');
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
