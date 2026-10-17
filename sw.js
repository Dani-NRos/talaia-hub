// Vigía Mesh: guarda la app en el móvil para que abra sin internet.
const CACHE = "vigia-mvcw8cu0";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

// Fondo del mapa (teselas de OpenStreetMap). Caché aparte, sin «vigia-» en el nombre: al actualizar la app
// se borran las cachés viejas de la app, y las teselas tienen que sobrevivir a eso.
const TILES = "teselas-osm";
const TILE_MAX = 2000; // ≈ 40 MB; al pasarse se borran las más antiguas
const TILE_FRESH_MS = 7 * 24 * 3600 * 1000; // más viejas que esto se renuevan en segundo plano si hay red
const STAMP = "x-vigia-guardada";
// Tesela transparente de 1×1 px: sin red ni copia, el mapa enseña su color de fondo en vez de una imagen rota.
const BLANK = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
let tilePuts = 0;

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys(); // en orden de guardado: las primeras son las más antiguas
  const extra = keys.length - TILE_MAX;
  if (extra > 0) await Promise.all(keys.slice(0, extra).map((k) => c.delete(k)));
}

/** Guarda la tesela con la hora, para saber después si toca renovarla. */
async function saveTile(url, res) {
  const body = await res.blob();
  const headers = { "content-type": res.headers.get("content-type") || "image/png", [STAMP]: String(Date.now()) };
  const c = await caches.open(TILES);
  await c.delete(url); // borrar y volver a guardar la deja al final: lo que se renueva no se desaloja primero
  await c.put(url, new Response(body, { status: 200, headers }));
  if (++tilePuts % 25 === 0) await trimTiles();
}

async function tile(e) {
  const req = e.request;
  const hit = await caches.match(req.url, { cacheName: TILES });
  if (hit) {
    const age = Date.now() - Number(hit.headers.get(STAMP) || 0);
    // Vieja: se enseña igual y se renueva por detrás; sin red no pasa nada, sigue la copia.
    if (age > TILE_FRESH_MS) e.waitUntil(fetch(req).then((r) => r.ok && saveTile(req.url, r)).catch(() => {}));
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok) e.waitUntil(saveTile(req.url, res.clone()).catch(() => {}));
    return res;
  } catch {
    return new Response(BLANK, { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("vigia-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => trimTiles()).catch(() => {}).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "tile.openstreetmap.org") { e.respondWith(tile(e)); return; }
  // Tipografías de Google: se guardan la primera vez que hay red.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; } catch { return new Response("", { status: 200, headers: { "content-type": url.hostname === "fonts.googleapis.com" ? "text/css" : "font/woff2" } }); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // App: primero la red (para coger actualizaciones), si no hay, la copia guardada.
  e.respondWith(fetch(req).then(async (res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }
    // La web responde con error (GitHub Pages caído, dirección movida): mejor la copia guardada que una página de error.
    return (await caches.match(req)) || (req.mode === "navigate" && (await caches.match("./index.html"))) || res;
  }).catch(async () => (await caches.match(req)) || (await caches.match("./index.html"))));
});

// Tocar una notificación devuelve a la app.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
