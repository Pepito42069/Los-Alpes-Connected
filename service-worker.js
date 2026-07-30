const CACHE_NAME = "vuelos-cercanos-cache-v1";
const ASSETS = [
  "./", "./index.html", "./app-logic.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Solo el shell de la app (mismo origen, GET) se cachea. Todo lo demás —
  // sobre todo las llamadas a la API de OpenSky y los tiles de OpenStreetMap
  // — va directo a la red sin pasar por la caché: son datos en vivo (posición
  // de aviones), y servir una respuesta vieja desde la caché sería peor que
  // no mostrar nada.
  if (!sameOrigin || event.request.method !== "GET") return;

  // Network-first, con la caché como respaldo solo si falla la red (offline).
  // Así el shell se actualiza solo con cada visita en línea, en vez de
  // quedarse pegado en la versión cacheada la primera vez que se instaló.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(event.request, copy))
          .catch(() => { /* cuota llena o respuesta no almacenable: no afecta a la app */ });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
