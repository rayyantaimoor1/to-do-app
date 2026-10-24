const CACHE_NAME = "todo-app-shell-v2";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const clone = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, clone);
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const clone = response.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, clone);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Cross-origin (Supabase REST/Realtime/Auth) and non-GET pass straight
  // through. Caching those is M4's job via IndexedDB, not the SW's.
  if (
    request.method !== "GET" ||
    new URL(request.url).origin !== self.location.origin
  ) {
    return;
  }

  const url = new URL(request.url);

  // HTML must never be served stale. A cached document references
  // content-hashed chunk URLs, and after a rebuild those files are gone —
  // serving the old HTML sends the app chasing 404s on every load.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Build output is content-hashed, so a given URL's bytes never change.
  // Safe (and fastest) to serve from cache without revalidating.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
