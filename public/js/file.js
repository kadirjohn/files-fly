/**
 * file.js — Dosya Önizleme Sayfası Script'i
 *
 * URL: /files/:id  (veya /files/:id/dl → routes/files.js şifreliyse buraya yönlendirir)
 * Akış:
 *   1. URL'den fileId çıkar
 *   2. /api/files/:id → metadata al
 *   3. Dosya bilgilerini göster (isim, boyut, tür, süre)
 *   4. Şifresizse: image ise direkt önizleme, buton = /api/files/:id/dl
 *   5. Şifreliyse: parola gate modal'ı aç → parola girilince
 *      a) ciphertext'i fetch et, AES-GCM ile deşifrele
 *      b) image ise preview göster, tüm dosyalar için indir butonu aktif olur
 *      c) İndir butonu deşifre edilmiş blob'u indirir (ham ciphertext değil)
 */

(function () {
  'use strict';

  const DOM = {
    loading: document.getElementById('loading'),
    errorState: document.getElementById('error-state'),
    errorTitle: document.getElementById('error-title'),
    errorMessage: document.getElementById('error-message'),
    fileInfo: document.getElementById('file-info'),
    fileIcon: document.getElementById('file-icon'),
    fileName: document.getElementById('file-name'),
    fileMeta: document.getElementById('file-meta'),
    encryptedBadge: document.getElementById('encrypted-badge'),
    imagePreview: document.getElementById('image-preview'),
    previewImg: document.getElementById('preview-img'),
    expiredWarning: document.getElementById('expired-warning'),
    downloadCountInfo: document.getElementById('download-count-info'),
    downloadCountValue: document.getElementById('download-count-value'),
    infoSize: document.getElementById('info-size'),
    infoType: document.getElementById('info-type'),
    infoExpire: document.getElementById('info-expire'),
    infoCreated: document.getElementById('info-created'),
    downloadBtn: document.getElementById('download-btn'),
    // Parola gate
    passwordGate: document.getElementById('password-gate'),
    gateFilename: document.getElementById('gate-filename'),
    gatePasswordInput: document.getElementById('gate-password-input'),
    gateToggleVisibility: document.getElementById('gate-toggle-visibility'),
    gateError: document.getElementById('gate-error'),
    gateProgress: document.getElementById('gate-progress'),
    gateProgressFill: document.getElementById('gate-progress-fill'),
    gateProgressText: document.getElementById('gate-progress-text'),
    gateSubmitBtn: document.getElementById('gate-submit-btn'),
  };

  // =========================================================================
  // URL'den fileId çıkar: /files/:id veya /files/:id/dl
  // =========================================================================
  const path = window.location.pathname;
  const match = path.match(/^\/files\/([a-f0-9-]{36})(\/dl)?$/i);
  if (!match) {
    showError('Geçersiz Dosya Linki', 'Bu link geçerli bir dosya bağlantısı değil.');
    return;
  }
  const fileId = match[1];
  const isDownload = !!match[2];

  // Aktif dosya metadata'sı + deşifre edilmiş blob URL'i (şifreli dosyalar için)
  let fileMeta = null;
  let decryptedBlobUrl = null;

  // =========================================================================
  // Metadata'yı çek
  // =========================================================================
  loadFile();

  async function loadFile() {
    try {
      dbg.info('download', `GET /api/files/${fileId}`, { isDownload });
      const resp = await fetch('/api/files/' + fileId);

      // 404 — dosya yok
      if (resp.status === 404) {
        dbg.warn('download', 'File not found (404)');
        showError('Dosya Bulunamadı', 'Bu dosya mevcut değil veya zaten silinmiş olabilir.');
        return;
      }

      // 410 — süresi dolmuş
      if (resp.status === 410) {
        const data = await resp.json().catch(() => ({}));
        dbg.warn('download', 'File expired (410)', data);
        showExpired(data.filename || 'Bilinmeyen dosya');
        return;
      }

      if (!resp.ok) {
        dbg.error('download', `Server error HTTP ${resp.status}`);
        showError('Bir Sorun Oluştu', 'Sunucu hatası (HTTP ' + resp.status + '). Lütfen daha sonra tekrar deneyin.');
        return;
      }

      const meta = await resp.json();
      fileMeta = meta;
      dbg.info('download', 'File metadata received', {
        filename: meta.filename,
        size: meta.size,
        is_encrypted: meta.is_encrypted,
        mime_type: meta.mime_type,
      });

      // Şifresiz /files/:id/dl ise → direkt indirmeye yönlendir
      if (isDownload && !meta.is_encrypted) {
        dbg.info('download', 'Unencrypted download — /dl redirect');
        window.location.href = '/api/files/' + fileId + '/dl';
        return;
      }

      renderFile(meta);

      // Şifreliyse parola gate'i aç
      if (meta.is_encrypted) {
        dbg.info('decrypt', 'File encrypted — opening password gate');
        openPasswordGate();
      }
    } catch (err) {
      dbg.error('download', 'loadFile network error', err);
      console.error('[file.js] loadFile error:', err);
      showError('Bağlantı Hatası', 'Sunucuya ulaşılamıyor. İnternet bağlantınızı kontrol edin.');
    }
  }

  // =========================================================================
  // Render
  // =========================================================================
  function renderFile(meta) {
    DOM.loading.classList.add('hidden');
    DOM.fileInfo.classList.remove('hidden');

    // İsim
    DOM.fileName.textContent = meta.filename || 'Dosya';
    DOM.fileMeta.textContent = meta.mime_type || 'application/octet-stream';

    // İkon
    DOM.fileIcon.innerHTML = getFileIconSvg(meta.mime_type);

    // İndirme sayacı
    if (meta.download_count && meta.download_count > 0) {
      DOM.downloadCountInfo.classList.remove('hidden');
      DOM.downloadCountValue.textContent = meta.download_count;
    }

    // Bilgi kartları
    DOM.infoSize.innerHTML = `<span class="meta-badge meta-badge-size">${formatSize(parseInt(meta.file_size) || 0)}</span>`;
    DOM.infoType.textContent = meta.mime_type || 'Bilinmiyor';
    DOM.infoExpire.innerHTML = `<span class="meta-badge meta-badge-time">${meta.expire_at ? formatDateTime(meta.expire_at) : '-'}</span>`;
    DOM.infoCreated.textContent = meta.created_at ? formatDateTime(meta.created_at) : '-';

    // Şifreli rozet
    if (meta.is_encrypted) {
      DOM.encryptedBadge.classList.remove('hidden');
    } else {
      DOM.encryptedBadge.classList.add('hidden');
    }

    // İndirme butonu handler'ı
    setupDownloadButton(meta);

    // Önizleme: tüm türler ortak FFPreview modülüyle (video/audio/pdf/text fix).
    // Şifresiz → FFPreview /api/files/:id/thumb + /dl stream'ini kendisi yönetir.
    if (!meta.is_encrypted) {
      FFPreview.render(DOM.imagePreview, {
        fileId, filename: meta.filename, mimeType: meta.mime_type, isEncrypted: false,
      });
      DOM.imagePreview.classList.remove('hidden');
    }
  }

  // İndirme butonunu yapılandır
  function setupDownloadButton(meta) {
    // Önceki listener'ları temizle
    const newBtn = DOM.downloadBtn.cloneNode(true);
    DOM.downloadBtn.parentNode.replaceChild(newBtn, DOM.downloadBtn);
    DOM.downloadBtn = newBtn;

    newBtn.addEventListener('click', () => {
      if (meta.is_encrypted) {
        // Şifreli: gate açık değilse aç, açıksa ve çözüldüyse blob'u indir
        if (decryptedBlobUrl) {
          triggerBlobDownload(decryptedBlobUrl, meta.filename);
        } else {
          openPasswordGate();
        }
      } else {
        // Şifresiz: doğrudan API indirme
        window.location.href = '/api/files/' + fileId + '/dl';
      }
    });
  }

  function showExpired(filename) {
    DOM.loading.classList.add('hidden');
    DOM.fileInfo.classList.remove('hidden');
    DOM.fileName.textContent = filename;
    DOM.expiredWarning.classList.remove('hidden');
    DOM.downloadBtn.classList.add('hidden');
    DOM.imagePreview.classList.add('hidden');
    DOM.fileMeta.textContent = 'Süresi dolmuş';
  }

  function showError(title, message) {
    DOM.loading.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
    DOM.errorTitle.textContent = title;
    DOM.errorMessage.textContent = message;
  }

  // =========================================================================
  // Parola Gate (şifreli dosyalar)
  // =========================================================================

  function openPasswordGate() {
    if (!fileMeta) return;
    DOM.gateFilename.textContent = fileMeta.filename || 'Dosya';
    DOM.gateError.classList.add('hidden');
    DOM.gateProgress.classList.add('hidden');
    DOM.gatePasswordInput.value = '';
    DOM.gateSubmitBtn.disabled = false;
    DOM.passwordGate.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => DOM.gatePasswordInput.focus(), 50);
  }

  function closePasswordGate() {
    DOM.passwordGate.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Modal dışına tıklayınca kapat
  DOM.passwordGate.addEventListener('click', (e) => {
    if (e.target === DOM.passwordGate) closePasswordGate();
  });

  // Escape ile kapat
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.passwordGate.classList.contains('hidden')) {
      closePasswordGate();
    }
  });

  // Parola göster/gizle
  DOM.gateToggleVisibility.addEventListener('click', () => {
    const input = DOM.gatePasswordInput;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Enter ile submit
  DOM.gatePasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') DOM.gateSubmitBtn.click();
  });

  // Submit
  DOM.gateSubmitBtn.addEventListener('click', handlePasswordSubmit);

  async function handlePasswordSubmit() {
    if (!fileMeta || !fileMeta.is_encrypted) return;

    const password = DOM.gatePasswordInput.value;
    if (!password) {
      showGateError('Lütfen parolayı girin.');
      return;
    }

    if (!fileMeta.encryption_iv || !fileMeta.encryption_salt) {
      showGateError('Şifreleme bilgileri eksik. Dosya hasarlı olabilir.');
      return;
    }

    DOM.gateSubmitBtn.disabled = true;
    DOM.gateError.classList.add('hidden');
    DOM.gateProgress.classList.remove('hidden');
    setGateProgress(10, 'Şifreli dosya indiriliyor...');

    try {
      // 1. Ciphertext'i indir
      const dlResp = await fetch('/api/files/' + fileId + '/dl');
      if (!dlResp.ok) {
        throw new Error('Dosya indirilemedi. Süresi dolmuş olabilir (HTTP ' + dlResp.status + ').');
      }
      const ciphertext = await dlResp.arrayBuffer();
      setGateProgress(50, 'Şifre çözülüyor...');

      // 2. Deşifrele (FFCrypto — crypto.js)
      const plaintext = await FFCrypto.decryptFile(
        ciphertext,
        fileMeta.encryption_iv,
        fileMeta.encryption_salt,
        password
      );

      setGateProgress(90, 'İçerik hazırlanıyor...');

      // 3. Blob URL oluştur (preview + indirme için)
      const blob = new Blob([plaintext], { type: fileMeta.mime_type || 'application/octet-stream' });
      if (decryptedBlobUrl) URL.revokeObjectURL(decryptedBlobUrl);
      decryptedBlobUrl = URL.createObjectURL(blob);

      setGateProgress(100, 'Hazır!');
      DOM.gateProgressText.textContent = 'Kilit açıldı. Dosyayı indirebilirsiniz.';

      // 4. Önizleme: çözülmüş blob URL'iyle FFPreview tüm türleri render eder
      //    (video/audio/pdf/text — şifreli MP4'ler artık preview'siz kalmaz).
      FFPreview.render(DOM.imagePreview, {
        fileId, filename: fileMeta.filename, mimeType: fileMeta.mime_type,
        isEncrypted: true, decryptedBlobUrl,
      });
      DOM.imagePreview.classList.remove('hidden');

      // 5. Gate'i kapat ve başarı bildir
      setTimeout(() => {
        closePasswordGate();
        // İlk girişte (isDownload=true) otomatik indirme başlat
        if (isDownload) {
          triggerBlobDownload(decryptedBlobUrl, fileMeta.filename);
        }
      }, 600);

    } catch (err) {
      console.error('[file.js] decrypt error:', err);
      showGateError(err.message || 'Şifre çözme başarısız. Parola yanlış olabilir.');
      DOM.gateProgress.classList.add('hidden');
      DOM.gateSubmitBtn.disabled = false;
    }
  }

  function showGateError(message) {
    DOM.gateError.textContent = message;
    DOM.gateError.classList.remove('hidden');
  }

  function setGateProgress(percent, text) {
    DOM.gateProgressFill.style.width = percent + '%';
    DOM.gateProgressText.textContent = text;
  }

  // =========================================================================
  // Blob indir
  // =========================================================================
  function triggerBlobDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'dosya';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // =========================================================================
  // Yardımcılar
  // =========================================================================
  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function formatDateTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  // CSP-safe SVG ikonlar (inline emoji yerine — emoji'ler kaldırıldı)
  function getFileIconSvg(mimeType) {
    const svg = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="40" height="40">${p}</svg>`;
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
