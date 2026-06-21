/**
 * sw.js — Files Fly Service Worker
 *
 * Stale-while-revalidate stratejisi:
 * - Statik asset'ler (CSS, JS, favicon) cache'lenir
 * - HTML sayfaları network-first (her zaman güncel)
 * - API istekleri cache'lenmez
 */

const CACHE_NAME = 'filesfly-v1';
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/session.js',
  '/js/admin.js',
  '/favicon.svg',
  '/manifest.json',
];

// =========================================================================
// Install — Statik asset'leri cache'le
// =========================================================================

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).catch((err) => {
      console.error('[SW] Cache preload failed:', err);
    })
  );
  self.skipWaiting();
});

// =========================================================================
// Activate — Eski cache'leri temizle
// =========================================================================

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// =========================================================================
// Fetch — Stale-while-revalidate
// =========================================================================

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API isteklerini cache'leme
  if (url.pathname.startsWith('/api/')) {
    return; // Network-only
  }

  // HTML sayfaları: network-first
  if (event.request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Statik asset'ler: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// =========================================================================
// Stratejiler
// =========================================================================

/**
 * Network-first: Önce network, başarısızsa cache.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Başarılı response'u cache'le
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline — sayfa kullanılamıyor.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Stale-while-revalidate: Önce cache, arka planda network güncellemesi.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Arka planda network'ten güncelle
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Cache varsa hemen döndür, yoksa network'ü bekle
  return cached || fetchPromise.then(r => r || new Response('Offline', { status: 503 }));
}
