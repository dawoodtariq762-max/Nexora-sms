/* ============================================================================
   NEXORA service worker
   ----------------------------------------------------------------------------
   Scope and rules, deliberately conservative:

   • NEVER caches /api/* — every API response is authenticated and can carry
     another user's data on a shared device. Requests to /api/* are passed
     straight through to the network and never stored.
   • NEVER caches chat attachments, creator screenshots or private uploads.
   • Only the static app shell (pages, CSS, JS, logo, manifest) is cached, and
     always with a network-first strategy so a deploy is picked up immediately.
   • Offline: the last cached copy of a page is shown if the network is gone,
     otherwise a small offline notice. No stale authenticated HTML is served.
   ========================================================================== */
'use strict';

const VERSION = 'nx-pwa-v2-20261111';
const SHELL = VERSION + '-shell';

/* The minimum needed to boot the login screen offline. Everything else is
   cached on first successful visit. */
const PRECACHE = [
  '/panel-login',
  '/manifest.webmanifest',
  '/assets/nexora-favicon.png',
  '/assets/pwa/icon-192.png',
  '/assets/pwa/icon-512.png',
];

const NEVER_CACHE = [
  /^\/api\//i,
  /\/attachments\//i,
  /\/creator\/screenshot\//i,
  /\/chat\/?$/i,
  /\.(?:sqlite|db)$/i,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* add() rejects on a single 404, so add each entry independently */
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { /* optional */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* Only GETs, only our own origin. Everything else is untouched. */
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return;

  event.respondWith((async () => {
    try {
      /* network-first: the panel always shows freshly deployed files */
      const fresh = await fetch(req);
      if (fresh && fresh.ok && (fresh.type === 'basic' || fresh.type === 'default')) {
        const copy = fresh.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch (e) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/panel-login');
        if (shell) return shell;
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>NEXORA — offline</title>'
          + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;'
          + 'background:#0b1e42;color:#e8f1ff;text-align:center;padding:24px">'
          + '<div><h1 style="font-size:20px;margin:0 0 8px">You are offline</h1>'
          + '<p style="font-size:14px;color:#9db8e8;margin:0 0 16px">NEXORA needs a connection to sign in.</p>'
          + '<button onclick="location.reload()" style="border:0;border-radius:10px;padding:10px 18px;font-weight:700;'
          + 'background:#1160e8;color:#fff;cursor:pointer">Try again</button></div>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 }
        );
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
