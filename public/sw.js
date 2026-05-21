const CACHE_VERSION = 'bibi-v4';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const BASE = self.registration.scope;

const SHELL_ASSETS = [
  BASE,
  `${BASE}index.html`,
  `${BASE}NaikaiFont-SemiBold.woff2`,
  `${BASE}icon.png`,
];

const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
  'cdn.jsdelivr.net',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 來自前端的訊息：要求 SW 立刻接管，免去使用者等下次開 app 才更新
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com')) {
    return;
  }

  if (url.origin === self.location.origin) {
    // HTML / navigation 請求：network-first，沒網路才 fallback 快取
    // 避免 PWA 永遠卡在最早安裝的版本。
    const isHTMLNav = req.mode === 'navigate' || req.destination === 'document';
    if (isHTMLNav) {
      event.respondWith(
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => caches.match(req).then((c) => c || caches.match(`${BASE}index.html`)))
      );
      return;
    }
    // 靜態資源 (JS/CSS 都帶 hash 檔名)：cache-first
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  if (CDN_HOSTS.some((host) => url.hostname.endsWith(host))) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const networkFetch = fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
  }
});
