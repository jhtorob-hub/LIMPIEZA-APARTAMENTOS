// Service worker mínimo: permite instalar la app y abrirla aunque la red esté lenta.
// Siempre intenta primero la red, así cada vez que se abre carga la última versión.
const CACHE = "limpieza-v1";
const BASICOS = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICOS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.endsWith(".apk")) return;
  e.respondWith(fetch(req).then((res) => { if (res.ok && (req.mode === "navigate" || BASICOS.includes(url.pathname))) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "/" : req, cp)); } return res; })
    .catch(() => caches.match(req.mode === "navigate" ? "/" : req)));
});
