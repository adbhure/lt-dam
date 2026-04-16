// ================================================================
// L&T AssetOps — Service Worker
// Provides: offline support, asset caching, install prompt
//
// CACHE STRATEGY:
//   - App shell (HTML, CSS, fonts) → Cache First (instant load)
//   - Web App API calls (Google Script) → Network First (fresh data)
//   - Google Sheets CSV → Network with cache fallback
//
// VERSION: bump CACHE_NAME when you update index.html so old
// caches are cleared automatically on next visit.
// ================================================================

var CACHE_NAME = 'lt-assetops-v1';

// Files to cache on install — the "app shell"
var PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  // Google Fonts are cached when first loaded
];

// ── INSTALL: pre-cache the app shell ───────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(function() {
        // Take control immediately — don't wait for old SW to die
        return self.skipWaiting();
      })
  );
});

// ── ACTIVATE: clean up old caches ──────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      // Claim all open clients immediately
      return self.clients.claim();
    })
  );
});

// ── FETCH: handle all network requests ─────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // ── 1. Google Apps Script Web App (form submissions + checks)
  //    → Always try network first. If offline, return a JSON error
  //    so the form can handle it gracefully.
  if (url.indexOf('script.google.com') !== -1) {
    event.respondWith(
      fetch(event.request.clone())
        .catch(function() {
          // Offline fallback — form will use localStorage data
          return new Response(
            JSON.stringify({
              ok: false,
              offline: true,
              error: 'Device is offline. Data saved locally on device.'
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // ── 2. Google Sheets CSV (asset master lookup)
  //    → Network first, fall back to cache if offline
  if (url.indexOf('docs.google.com') !== -1) {
    event.respondWith(
      fetch(event.request.clone())
        .then(function(response) {
          // Cache successful response for offline use
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(function() {
          // Offline — serve cached sheet data if available
          return caches.match(event.request).then(function(cached) {
            if (cached) return cached;
            // No cache — return empty CSV so LOCAL_DB takes over
            return new Response('AssetCode,Description,AssetType,Category,StdHours,Make,Status\n',
              { headers: { 'Content-Type': 'text/csv' } });
          });
        })
    );
    return;
  }

  // ── 3. Google Fonts
  //    → Cache first (fonts never change for same URL)
  if (url.indexOf('fonts.googleapis.com') !== -1 || url.indexOf('fonts.gstatic.com') !== -1) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request.clone()).then(function(response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          return response;
        });
      })
    );
    return;
  }

  // ── 4. App shell (index.html, manifest, icons)
  //    → Cache first, then network. Always update cache in background.
  if (url.indexOf(self.location.origin) !== -1 || url.indexOf('adbhure.github.io') !== -1) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        var fetchPromise = fetch(event.request.clone()).then(function(response) {
          // Update cache with fresh version
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          return response;
        });
        // Return cache instantly if available, fetch runs in background
        return cached || fetchPromise;
      })
    );
    return;
  }

  // ── 5. Everything else → normal network request
  event.respondWith(fetch(event.request));
});

// ── BACKGROUND SYNC (for offline form submissions) ─────────
// When operator submits offline, form saves to localStorage.
// When connection restored, this sync fires automatically.
self.addEventListener('sync', function(event) {
  if (event.tag === 'sync-pending-submissions') {
    console.log('[SW] Background sync triggered: syncing pending submissions');
    event.waitUntil(syncPendingSubmissions());
  }
});

function syncPendingSubmissions() {
  // The form's localStorage holds submitted data.
  // Notify all open clients to retry any pending submissions.
  return self.clients.matchAll().then(function(clients) {
    clients.forEach(function(client) {
      client.postMessage({ type: 'SYNC_PENDING' });
    });
  });
}

// ── PUSH NOTIFICATIONS (future use) ────────────────────────
self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  var title   = data.title   || 'L&T AssetOps Alert';
  var options = {
    body:    data.body    || 'You have a new notification',
    icon:    './icons/icon-192.png',
    badge:   './icons/icon-72.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || './index.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || './index.html')
  );
});
