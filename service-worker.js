const CACHE_NAME = "vuelos-cercanos-cache-v7";
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
  // sobre todo las llamadas a las APIs de datos ADS-B y los tiles de OSM
  // — va directo a la red sin pasar por la caché: son datos en vivo (posición
  // de aviones), y servir una respuesta vieja desde la caché sería peor que
  // no mostrar nada.
  if (!sameOrigin || event.request.method !== "GET") return;

  // Cache-first con revalidación en segundo plano. Antes era network-first, lo
  // que obligaba a esperar la ida y vuelta por el HTML y el JS en cada
  // apertura, incluso con la copia ya guardada. Ahora el shell se pinta al
  // instante desde la caché mientras la versión nueva se descarga aparte y
  // queda lista para la siguiente apertura.
  //
  // Esto no afecta a los datos de vuelo: son de otro origen y ni siquiera
  // entran aquí.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const enRed = fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => { /* cuota llena o respuesta no almacenable: no afecta a la app */ });
          return response;
        })
        .catch(() => cached);
      return cached || enRed;
    })
  );
});
