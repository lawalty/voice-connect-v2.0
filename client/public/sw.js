// Cache the public shell and exact static speech runtime assets; never API data or recordings.
const CACHE = 'vc2-shell-v3';
const RUNTIME = ['/audio/vosk.worker.js', '/runtime/vosk.js', '/runtime/ort-wasm-simd-threaded.wasm', '/models/silero_vad.onnx'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('vc2-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if ((url.pathname.startsWith('/models/') || url.pathname.startsWith('/audio/')) && !RUNTIME.includes(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async response => { if (response.ok && response.headers.get('content-type')?.includes('text/html')) { const cache = await caches.open(CACHE); await cache.put('/', response.clone()); } return response; }).catch(() => caches.match('/').then(response => response || Response.error())));
  } else if (url.pathname.startsWith('/assets/') || RUNTIME.includes(url.pathname) || ['/icon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => { const cached = await cache.match(event.request); if (cached) return cached; const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }));
  }
});
