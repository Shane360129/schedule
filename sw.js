const CACHE_VERSION = 'bibi-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './NaikaiFont-SemiBold.woff2',
  './icon.png',
];

const CDN_HOSTS = [
  'esm.sh',
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
  'cdn.jsdelivr.net',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
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
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  if (CDN_HOSTS.some((host) => url.hostname.endsWith(host))) {
    event.respondWith(
      caches.open(CDN_CACHE).then((cache) =>
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
