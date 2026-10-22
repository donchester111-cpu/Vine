/* Vine PWA: cache only the public app shell. API/auth/payment responses are network-only. */
'use strict';
const CACHE_NAME = 'vine-shell-v1';
const SHELL = ['./index.html', './manifest.webmanifest', './favicon.png', './icons/vine-192.png', './icons/vine-512.png', './icons/vine-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('vine-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never intercept API endpoints, authentication, checkout, or payment URLs.
  if (/\/api(?:\/|$)|auth|login|checkout|payment|paystack|session|token/i.test(url.pathname + url.search)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
      }
      return response;
    }).catch(async () => (await caches.match('./index.html')) || new Response('Vine Store is offline. Connect to the internet to shop, view live products, sign in, or pay.', {status: 503, headers: {'Content-Type':'text/plain; charset=utf-8'}})));
    return;
  }
  // Cache only explicitly listed static shell assets; do not cache product/API data.
  if (SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
