// Keeps the app on the iPad for offline use. Serves the saved copy first, then refreshes it in the background,
// so a new version is picked up the next time the app opens.
const CACHE = 'ac-picking-v2';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'parse.js', 'pdf.min.js', 'pdf.worker.min.js', 'pdf-lib.min.js', 'label-template.pdf', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// A filtered work network can answer with its own "blocked" page instead of the file. Only real copies of the
// app's files replace the saved ones, so the app keeps opening from its saved copy.
const TYPES = { css: 'css', js: 'javascript', pdf: 'pdf', png: 'image/', webmanifest: 'json' };
async function genuine(res, path) {
  if (!res.ok || res.redirected) return false;
  const type = res.headers.get('content-type') || '', want = TYPES[path.split('.').pop()];
  if (want) return type.includes(want);
  return type.includes('text/html') && (await res.clone().text()).includes('<main id="main">');
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : req, path = req.mode === 'navigate' ? 'index.html' : new URL(req.url).pathname;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then(async res => { if (await genuine(res, path)) await cache.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('Offline', { status: 503 });
  }));
});
