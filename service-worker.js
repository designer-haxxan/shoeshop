/* Service worker: precaches the app shell and CDN libraries so the POS loads fully offline.
   Bump VERSION whenever any cached file changes; clients update automatically. */
// Cache names are namespaced: other apps on the same origin share Cache Storage with this one.
const APP_ID = 'disterp';
const VERSION = `${APP_ID}-v2.0.1`;
const isOwnCache = (key) => key.startsWith(`${APP_ID}-`) || /^saleapp-v/.test(key); // saleapp-v* = this app's older builds
const SHELL = [
  './', './index.html', './manifest.json', './css/app.css',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png', './icons/shoe.svg',
  './js/app.js', './js/config.js', './js/core/shoe.js',
  './js/core/link-login.js', './js/core/settings.js', './js/core/ui.js', './js/core/utils.js', './js/core/views.js',
  './js/db/idb.js', './js/db/schema.js',
  './js/modules/accounts.js', './js/modules/backup.js', './js/modules/dashboard.js', './js/modules/documents.js',
  './js/modules/parties.js', './js/modules/pos.js', './js/modules/products.js', './js/modules/settings.js', './js/modules/stock.js', './js/modules/vouchers.js',
  './js/printer/escpos.js', './js/printer/printer.js', './js/printer/raster.js', './js/printer/receipt.js',
  './js/reports/reports.js', './js/scanner/scanner.js',
  './js/services/auth.js', './js/services/backup.js', './js/services/catalog.js', './js/services/posting.js',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.1.0/index.css',
  'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
];

async function cacheCdn(cache) {
  for (const url of CDN) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
      if (!res.ok) continue;
      await cache.put(url, res.clone());
      // Also cache fonts referenced by stylesheets (Bootstrap Icons).
      if (url.endsWith('.css')) {
        const css = await res.text();
        for (const m of css.matchAll(/url\(["']?([^"')]+\.woff2?[^"')]*)["']?\)/g)) {
          const fontUrl = new URL(m[1], url).href;
          try { const f = await fetch(fontUrl, { mode: 'cors', credentials: 'omit' }); if (f.ok) await cache.put(fontUrl, f); } catch (e) { /* retry at runtime */ }
        }
      }
    } catch (e) { /* offline during install: cached at runtime later */ }
  }
}

async function precache() {
  const cache = await caches.open(VERSION);
  // cache: 'reload' bypasses the browser HTTP cache, so a new version never stores stale files
  // (GitHub Pages lets browsers cache files for 10 minutes).
  await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
  await cacheCdn(cache);
  // Urdu font (large): cached for offline receipts; install still succeeds if this download fails.
  try { await cache.add(new Request('./fonts/jameel-noori-nastaleeq.woff', { cache: 'reload' })); } catch (e) { /* cached at runtime later */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precache();
    // Activate new versions immediately; open pages reload on controllerchange (POS carts are kept as drafts).
    await self.skipWaiting();
  })());
});

// Another app on this origin may have deleted our cache; the page asks us to rebuild it when online.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ENSURE_CACHE') {
    event.waitUntil((async () => { if (!(await caches.has(VERSION)) || !(await (await caches.open(VERSION)).match('./index.html'))) await precache(); })());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only delete this app's own old caches — never other apps' caches on the shared origin.
    for (const key of await caches.keys()) if (key !== VERSION && isOwnCache(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    // App shell: serve the cached index.html of this version (works offline). New versions arrive via a new service worker.
    event.respondWith((async () => {
      const cached = await caches.match('./index.html', { cacheName: VERSION });
      if (cached) return cached;
      try { return await fetch(req); } catch (e) { return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
    return;
  }

  // Never cache API traffic (login etc.).
  if (url.pathname.startsWith('/api/')) return;
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isCdn) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: sameOrigin });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
