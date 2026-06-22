/**
 * debug.js — Files Fly Centralized Debug Logger
 *
 * Silent in production (zero overhead), detailed console logging in debug mode.
 *
 * ACTIVATION METHODS:
 *   1. localStorage:      localStorage.setItem('filesfly_debug', '1')
 *   2. URL param:         http://localhost:9392/?debug=1  (writes to sessionStorage)
 *   3. Console:           dbg.enable()  /  dbg.disable()
 *   4. Tag filter:        localStorage.setItem('filesfly_debug_tags', 'upload,login')
 *                         '*' = all tags (default)
 *
 * USAGE:
 *   dbg.log('upload', 'Chunk 3/10 sent', { size: chunk.size })
 *   dbg.info('login', 'Login successful', { user: 'admin' })
 *   dbg.warn('api', 'Slow response', { ms: 2500 })
 *   dbg.error('decrypt', 'Decryption error', err)
 *   dbg.group('upload', 'Chunked upload starting')
 *     dbg.log('upload', '...', ...)
 *   dbg.groupEnd('upload')
 *
 * TAGS (examples):
 *   login, api, upload, chunk, download, decrypt, session, storage,
 *   cred, preview, admin, crypto, ui
 *
 * OUTPUT FORMAT:
 *   [12:34:56.789] [upload] ▸ Chunk 3/10 sent {size: 5242880}
 *   Colors: log=gray, info=blue, warn=yellow, error=red, group=cyan
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'filesfly_debug';
  const TAGS_KEY = 'filesfly_debug_tags';

  // Tag başına renk (console styling)
  const LEVEL_STYLES = {
    log: 'color: #6b7280; font-weight: 500',
    info: 'color: #3b82f6; font-weight: 600',
    warn: 'color: #f59e0b; font-weight: 600',
    error: 'color: #ef4444; font-weight: 700',
    group: 'color: #06b6d4; font-weight: 700; font-size: 0.95em',
    groupEnd: 'color: #6b7280; font-style: italic',
  };

  // Tag başına ikon (görsel ayırt etme)
  const TAG_ICONS = {
    login: '🔑',
    api: '🌐',
    upload: '📤',
    chunk: '📦',
    download: '📥',
    decrypt: '🔓',
    encrypt: '🔒',
    session: '🍪',
    storage: '🗄️',
    cred: '🔑',
    preview: '👁️',
    admin: '🛡️',
    crypto: '🔐',
    ui: '🎨',
    config: '⚙️',
  };

  /**
   * Debug modu aktif mi?
   * localStorage veya URL ?debug=1 parametresi kontrol edilir.
   */
  function isEnabled() {
    try {
      // URL param: ?debug=1 → sessionStorage'a yaz (sayfa geçişlerinde kaybolmasın)
      const url = new URL(global.location.href);
      if (url.searchParams.get('debug') === '1') {
        sessionStorage.setItem(STORAGE_KEY, '1');
      }
      return localStorage.getItem(STORAGE_KEY) === '1' ||
             sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Tag filtreleri — hangi tag'ler loglansın?
   * '*' veya boş = tümü. Virgülle ayrılmış liste: "upload,login"
   */
  function getAllowedTags() {
    try {
      const raw = localStorage.getItem(TAGS_KEY) || '*';
      if (raw === '*') return null; // null = tümü
      return raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    } catch {
      return null;
    }
  }

  function tagAllowed(tag, allowed) {
    if (!allowed) return true; // null = tümü
    return allowed.includes(tag.toLowerCase());
  }

  /**
   * Timestamp formatla: HH:MM:SS.mmm
   */
  function timestamp() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  }

  /**
   * Hassas alanları maskele (güvenlik: log'larda şifre/token görünmesin).
   * Production'da bile debug açılsa bile bu alanlar *** olarak görünür.
   */
  const SENSITIVE_KEYS = [
    'password', 'passwd', 'secret', 'token', 'authorization',
    'apikey', 'api_key', 'accesskey', 'access_key',
    'privatekey', 'private_key', 'credentials',
    'encryption_key', 'master_key', 'mastervault',
  ];

  function redact(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (obj instanceof Error) return obj; // Error objeleri olduğu gibi kalsın
    try {
      const clone = Array.isArray(obj) ? [...obj] : { ...obj };
      for (const key in clone) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.some(s => lowerKey.includes(s))) {
          clone[key] = '***REDACTED***';
        } else if (typeof clone[key] === 'object' && clone[key] !== null) {
          clone[key] = redact(clone[key]);
        }
      }
      return clone;
    } catch {
      return obj;
    }
  }

  /**
   * Veriyi string'e çevir (obje/array → JSON, diğer → String).
   * Hassas alanlar (password, token, secret) otomatik maskelenir.
   */
  function serialize(data) {
    if (data === undefined) return '';
    if (data instanceof Error) return data.stack || data.message;
    if (typeof data === 'object') {
      try {
        const safe = redact(data);
        return JSON.stringify(safe);
      } catch { return String(data); }
    }
    return String(data);
  }

  /**
   * Çekirdek log fonksiyonu — tüm seviyeler bunu çağırır.
   */
  function emit(level, tag, message, data) {
    if (!isEnabled()) return;
    const allowed = getAllowedTags();
    if (!tagAllowed(tag, allowed)) return;

    const icon = TAG_ICONS[tag] || '•';
    const ts = timestamp();
    const style = LEVEL_STYLES[level] || LEVEL_STYLES.log;
    const prefix = `%c[${ts}] ${icon} [${tag}]`;
    const dataStr = data !== undefined ? ' ' + serialize(data) : '';

    // console.group / groupEnd özel handling
    if (level === 'group') {
      console.groupCollapsed(`${prefix} ▸ ${message}`, style);
      if (data !== undefined) console.log(serialize(data));
      return;
    }
    if (level === 'groupEnd') {
      console.groupEnd();
      return;
    }

    // Normal log: style + message + data
    const fn = (level === 'error') ? console.error :
               (level === 'warn')  ? console.warn  :
               (level === 'info')  ? console.info  : console.log;
    fn(`${prefix} ▸ ${message}${dataStr}`, style);
  }

  // ─── Public API ────────────────────────────────────────────────────────

  const dbg = {
    // Seviye bazlı
    log:   (tag, msg, data) => emit('log', tag, msg, data),
    info:  (tag, msg, data) => emit('info', tag, msg, data),
    warn:  (tag, msg, data) => emit('warn', tag, msg, data),
    error: (tag, msg, data) => emit('error', tag, msg, data),

    // Grup (collapsible)
    group:    (tag, msg, data) => emit('group', tag, msg, data),
    groupEnd: (tag) => emit('groupEnd', tag),

    // Tablo (obje/array'leri tablo olarak göster)
    table: (tag, data) => {
      if (!isEnabled()) return;
      if (!tagAllowed(tag, getAllowedTags())) return;
      console.log(`%c[${timestamp()}] • [${tag}] ▸ table`, LEVEL_STYLES.info);
      console.table(redact(data));
    },

    // Kontrol
    enable: () => {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
      console.info('%c[debug] ✓ Debug logging enabled', 'color: #10b981; font-weight: 700');
      console.info('%c[debug] Tag filter: ' + (localStorage.getItem(TAGS_KEY) || '* (all)'), 'color: #6b7280');
    },
    disable: () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      console.info('%c[debug] ✗ Debug logging disabled', 'color: #ef4444; font-weight: 700');
    },
    isEnabled,
    setTags: (tags) => {
      try { localStorage.setItem(TAGS_KEY, tags); } catch {}
      console.info(`%c[debug] Tag filter set: ${tags}`, 'color: #3b82f6');
    },

    // Kısayol: sadece belirli tag'leri göster
    only: (tags) => dbg.setTags(tags),
    all:  () => dbg.setTags('*'),

    // Yardımcı: timer (performans ölçümü)
    time: (tag, label) => {
      if (!isEnabled()) return;
      console.time(`[${tag}] ${label}`);
    },
    timeEnd: (tag, label) => {
      if (!isEnabled()) return;
      console.timeEnd(`[${tag}] ${label}`);
    },
  };

  // Global'e expose et
  global.dbg = dbg;

  // Debug aktifse hoş geldin mesajı
  if (isEnabled()) {
    console.info(
      '%c[debug] Files Fly Debug Logger enabled 🐛',
      'color: #06b6d4; font-weight: 700; font-size: 1.05em'
    );
    console.info(
      '%c[debug] Tag filter: ' + (localStorage.getItem(TAGS_KEY) || '* (all)') +
      ' | Disable: dbg.disable()',
      'color: #6b7280'
    );
  }
})(typeof window !== 'undefined' ? window : globalThis);
