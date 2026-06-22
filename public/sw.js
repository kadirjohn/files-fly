/**
 * sw.js — Files Fly Service Worker (KILL SWITCH)
 *
 * Service Worker caching bu projede impractical hale geldi: her güncellemede
 * kullanıcıların hard refresh yapması / cache temizlemesi gerekiyordu. Bu yüzden
 * SW tabanlı önbellekleme tamamen devre dışı bırakıldı.
 *
 * Bu dosya artık bir "kill switch" görevi görür:
 *   - Tüm cache'leri (Cache Storage) temizler
 *   - Kendi kaydını (registration) siler
 *   - Böylece daha önce register edilmiş SW'ler otomatik olarak temizlenir
 *     ve kullanıcıdan manuel bir işlem (hard refresh, DevTools) istemez.
 *
 * Not: app.js içinde SW registration zaten commented-out durumda, yani yeni
 * ziyaretçilerde SW hiç register edilmez. Bu dosya sadece eski ziyaretçilerin
 * kalıntı SW'lerini temizlemek için var.
 */

const CACHE_TAG = 'filesfly-kill';

// Install — hemen activate'e geç
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate — tüm cache'leri sil ve kaydı iptal et
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Tüm Cache Storage anahtarlarını sil
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));

    // 2. Tüm client'lara kontrolü devret (skipWaiting sonrası)
    await self.clients.claim();

    // 3. Kendi kaydını iptal et — artık SW kalmayacak
    const registrations = await self.registration.unregister();
    console.log('[SW] Kill switch: caches cleared, registration unregistered.');
  })());
});

// Fetch — hiçbir isteği engelleme/önbellekleme; passthrough (network-only)
self.addEventListener('fetch', (event) => {
  // SW unregister olana kadar gelen istekleri doğrudan network'e bırak
  return;
});
