/**
 * file.js — Dosya Önizleme Sayfası Script'i
 *
 * URL: /files/:id
 * Akış:
 *   1. URL'den fileId çıkar
 *   2. /api/files/:id → metadata al
 *   3. Dosya bilgilerini göster (isim, boyut, tür, süre)
 *   4. Image ise direkt görüntüle (full download URL ile)
 *   5. İndirme butonu = /api/files/:id/dl
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
    passwordProtected: document.getElementById('password-protected'),
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

  // =========================================================================
  // Metadata'yı çek
  // =========================================================================
  loadFile();

  async function loadFile() {
    try {
      const resp = await fetch('/api/files/' + fileId);

      // 404 — dosya yok
      if (resp.status === 404) {
        showError('Dosya Bulunamadı', 'Bu dosya mevcut değil veya zaten silinmiş olabilir.');
        return;
      }

      // 410 — süresi dolmuş
      if (resp.status === 410) {
        const data = await resp.json().catch(() => ({}));
        showExpired(data.filename || 'Bilinmeyen dosya');
        return;
      }

      if (!resp.ok) {
        showError('Bir Sorun Oluştu', 'Sunucu hatası (HTTP ' + resp.status + '). Lütfen daha sonra tekrar deneyin.');
        return;
      }

      const meta = await resp.json();

      // Eğer /files/:id/dl ise ve şifresizse → direkt indirmeye yönlendir
      if (isDownload) {
        window.location.href = '/api/files/' + fileId + '/dl';
        return;
      }

      renderFile(meta);
    } catch (err) {
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
    DOM.fileIcon.textContent = getFileIcon(meta.mime_type);

    // İndirme linki (parola hash'i URL fragment'ında korunur)
    const dlUrl = '/api/files/' + fileId + '/dl' + (window.location.hash || '');
    DOM.downloadBtn.href = dlUrl;

    // İndirme sayacı
    if (meta.download_count && meta.download_count > 0) {
      DOM.downloadCountInfo.classList.remove('hidden');
      DOM.downloadCountValue.textContent = meta.download_count;
    }

    // Bilgi kartları
    DOM.infoSize.textContent = formatSize(parseInt(meta.file_size) || 0);
    DOM.infoType.textContent = meta.mime_type || 'Bilinmiyor';
    DOM.infoExpire.textContent = meta.expire_at ? formatDateTime(meta.expire_at) : '-';
    DOM.infoCreated.textContent = meta.created_at ? formatDateTime(meta.created_at) : '-';

    // Image ise direkt önizleme göster (full download URL, tarayıcı streaming)
    if (meta.mime_type && meta.mime_type.startsWith('image/') && !meta.is_encrypted) {
      DOM.imagePreview.classList.remove('hidden');
      DOM.previewImg.src = dlUrl;
    }

    // Parola korumalı uyarısı
    if (meta.is_encrypted) {
      DOM.passwordProtected.classList.remove('hidden');
    }
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

  function getFileIcon(mimeType) {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return '📦';
    if (mimeType.startsWith('text/')) return '📝';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📄';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
    return '📄';
  }
})();
