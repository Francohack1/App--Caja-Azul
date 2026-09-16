/* Caja Fuerte — service worker
   ------------------------------------------------------------------
   Guarda la app en el teléfono para que abra sin conexión. Los datos
   NO se cachean nunca: las llamadas al Apps Script van siempre a la
   red, y si no hay, la app usa su propia cola (ver app.js).

   Si tocás index.html, app.js, styles.css o config.js, subí VERSION:
   así los teléfonos que ya tienen la app se quedan con la nueva.
   ------------------------------------------------------------------ */

const VERSION = 'v6';
const SHELL = 'caja-shell-' + VERSION;
const FUENTES = 'caja-fuentes-' + VERSION;

const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './iconos/icon-192.png',
  './iconos/icon-512.png',
  './iconos/apple-touch-icon.png'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Uno a uno: si falta un archivo suelto, la instalación no se cae entera.
    await Promise.all(ARCHIVOS.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(
      nombres
        .filter((n) => n.startsWith('caja-') && n !== SHELL && n !== FUENTES)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/** Devuelve lo cacheado al instante y actualiza por detrás. */
async function frescoDespues(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  const guardado = await cache.match(req);

  const red = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (guardado) return guardado;
  const res = await red;
  if (res) return res;
  throw new Error('sin red y sin caché');
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;               // los POST al backend, directos a la red

  const url = new URL(req.url);

  // Google Apps Script: nunca se cachea. Los datos vienen del servidor o no vienen.
  if (url.hostname.endsWith('script.google.com') ||
      url.hostname.endsWith('googleusercontent.com')) return;

  // Navegación: intentá la red, y si no hay, servÍ la app guardada.
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', res.clone());
        return res;
      } catch (e) {
        const cache = await caches.open(SHELL);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    ev.respondWith(frescoDespues(req, SHELL).catch(() => Response.error()));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    ev.respondWith(frescoDespues(req, FUENTES).catch(() => Response.error()));
  }
});
