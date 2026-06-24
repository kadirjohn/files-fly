// public/js/preview-render.js — Paylaşımlı önizleme renderer (image/video/audio/pdf/text).
//
// Share sayfasındaki (file.html) bozuk video/audio/pdf önizlemesini düzeltir:
// önceden sadece session.js modal'ında var olan render mantığını merkezi bir
// modüle taşır. file.js, bundle.js ve session.js aynı render fonksiyonunu kullanır
// → davranış her sayfada aynı, tek yerden bakım.
//
// API:
//   FFPreview.render(container, meta)  — container.innerHTML temizler + uygun element ekler.
//   FFPreview.stop(container)          — media'yı duraklat/teardown.
//
// meta = { fileId, filename, mimeType, isEncrypted, decryptedBlobUrl? }
//   - decryptedBlobUrl: şifreli dosya client-side decrypt edildiyse blob URL'si.
//     Yoksa/şifresizse render /api/files/:fileId/dl'i src olarak kullanır.

(function () {
  'use strict';

  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function render(container, meta) {
    if (!container) return;
    container.innerHTML = '';
    const {
      fileId, filename, mimeType = '', isEncrypted = false, decryptedBlobUrl = null,
    } = meta;

    // Şifreli → decrypted blob URL'si (browser-side), doğru MIME ile.
    // Şifresiz → /api/files/:fileId/dl stream'i.
    const src = decryptedBlobUrl || (fileId ? `/api/files/${fileId}/dl` : null);

    // --- Image ---
    if (mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'preview-img';
      img.alt = esc(filename);
      // Şifresiz: önce thumbnail (fallback full /dl). Şifreli: blob URL doğrudan.
      img.src = (!isEncrypted && fileId) ? `/api/files/${fileId}/thumb` : src;
      if (!isEncrypted && fileId) {
        img.onerror = () => { if (img.getAttribute('src') !== src) img.src = src; };
      }
      container.appendChild(img);
      return;
    }

    // --- Video ---
    // Inline sizing (audio:70 ve pdf:83 ile aynı patern): bundle.css/file-page.css'in
    // video kuralı bu sayfada yüklenmeyebilir → element intrinsic boyutta render eder,
    // taşar/kırılır. Inline vermek her sayfada (file.html, /session, /b/:id) garanti.
    if (mimeType.startsWith('video/')) {
      const v = document.createElement('video');
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.style.cssText = 'width:100%;max-height:64vh;border-radius:var(--radius-md);display:block;margin:0 auto;';
      const s = document.createElement('source');
      s.src = src;
      s.type = mimeType;
      v.appendChild(s);
      const fb = document.createElement('p');
      fb.className = 'text-muted text-sm';
      fb.textContent = 'Bu video formatı tarayıcıda oynatılamayabilir — indirin.';
      v.addEventListener('error', () => { container.appendChild(fb); });
      container.appendChild(v);
      return;
    }

    // --- Audio ---
    if (mimeType.startsWith('audio/')) {
      const a = document.createElement('audio');
      a.controls = true;
      a.style.width = '100%';
      const s = document.createElement('source');
      s.src = src;
      s.type = mimeType;
      a.appendChild(s);
      container.appendChild(a);
      return;
    }

    // --- PDF ---
    if (mimeType === 'application/pdf') {
      const ifr = document.createElement('iframe');
      ifr.src = src;
      ifr.style.cssText = 'width:100%;height:55vh;border:none;border-radius:8px;';
      container.appendChild(ifr);
      return;
    }

    // --- Text / JSON / JS ---
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript') {
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      const load = (url) => fetch(url)
        .then((r) => r.text())
        .then((t) => {
          pre.textContent = t.length > 100 * 1024 ? t.slice(0, 100 * 1024) + '\n…' : t;
        })
        .catch(() => { pre.textContent = 'Önizleme yüklenemedi.'; });
      if (isEncrypted && decryptedBlobUrl) {
        load(decryptedBlobUrl);
      } else if (fileId) {
        load(`/api/files/${fileId}/dl`);
      }
      container.appendChild(pre);
      return;
    }

    // --- Bilinmeyen tür ---
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent = 'Bu dosya türü için önizleme yok. İndir butonunu kullanın.';
    container.appendChild(p);
  }

  function stop(container) {
    const media = container && container.querySelector('video, audio');
    if (media) { try { media.pause(); } catch { /* already stopped */ } }
  }

  window.FFPreview = { render, stop };
})();
