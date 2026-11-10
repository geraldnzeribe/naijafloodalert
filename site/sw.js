// Offline shell + last-known data, so the map still opens on weak networks.
const CACHE = "nfa-v5";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/i18n.js", "icon.svg", "manifest.json", "data/geo/states.geojson", "data/geo/lgas.geojson"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  // Network first for data and code (always fresh), cache as fallback.
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
