// ---------- Lógica de la app (cálculos, datos, render de lista) ----------
// Separado de index.html para mantenibilidad, siguiendo el mismo patrón
// usado en Hacienda Los Alpes.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Cualquier texto que venga de fuera (sobre todo el callsign reportado por
// la red ADS-B) pasa por aquí antes de tocar innerHTML — evita que un
// callsign con "<script>" o similar se ejecute como HTML.
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

// Proveedores de datos ADS-B. Los tres son públicos, sin llave ni cuenta, y
// exponen la misma forma de respuesta (formato readsb/tar1090 "v2": un array
// `ac` de objetos), así que un solo parser sirve para todos.
//
// Se reemplazó a OpenSky porque sus respuestas no traen el header
// Access-Control-Allow-Origin: el servidor responde bien si abres la URL
// directo, pero el navegador bloquea la lectura desde fetch() y Safari lo
// reporta como el error genérico "Load failed". Estos tres sí están pensados
// para consumirse desde el navegador.
export const PROVIDERS = [
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
];

export const DEFAULT_RADIUS_NM = 100; // ~185 km
const FETCH_TIMEOUT_MS = 12000;

const FEET_TO_M = 0.3048;
const KNOTS_TO_KMH = 1.852;

export function toRad(deg) {
  return deg * Math.PI / 180;
}

// Distancia entre dos puntos sobre la esfera terrestre, en km.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rumbo (0-360°) desde el punto 1 hacia el punto 2.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

const BEARING_DIRS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
export function bearingLabel(deg) {
  return BEARING_DIRS[Math.round(deg / 45) % 8];
}

// El centro que se le manda al proveedor se redondea a ~1 km: el radio de
// búsqueda es de cientos de km, así que la precisión exacta no aporta nada
// y no hay razón para enviarle tu ubicación exacta a un tercero. Las
// distancias de la lista sí se calculan con la posición precisa, localmente.
export function coarseCoord(value) {
  return Math.round(value * 100) / 100;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Normaliza la respuesta de cualquiera de los proveedores a los objetos de
// vuelo que usa la app, filtrando los que no reportan posición y ordenando
// por cercanía.
export function parseAircraft(data, userLat, userLon) {
  const list = Array.isArray(data && data.ac) ? data.ac : [];
  return list
    .map((a) => {
      const lat = Number(a && a.lat), lon = Number(a && a.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      // alt_baro llega en pies, o como la cadena "ground" para aviones en
      // tierra; alt_geom sirve de respaldo cuando no hay altitud barométrica.
      const onGround = a.alt_baro === "ground";
      const altFt = Number(a.alt_baro ?? a.alt_geom);
      const speedKt = Number(a.gs);
      const track = Number(a.track);

      return {
        icao24: typeof a.hex === "string" ? a.hex : "",
        callsign: (typeof a.flight === "string" ? a.flight.trim() : "") || "N/A",
        lat, lon,
        onGround,
        altitudeM: !onGround && Number.isFinite(altFt) ? altFt * FEET_TO_M : null,
        speedKmh: Number.isFinite(speedKt) ? speedKt * KNOTS_TO_KMH : null,
        track: Number.isFinite(track) ? track : 0,
        dist: haversineKm(userLat, userLon, lat, lon),
        brg: bearingDeg(userLat, userLon, lat, lon),
      };
    })
    .filter((f) => f !== null)
    .sort((a, b) => a.dist - b.dist);
}

// Pide los vuelos cercanos, probando los proveedores en orden hasta que uno
// responda. Si ninguno lo hace, lanza un error con el detalle de cada intento
// (útil para saber si fue CORS, un 429, o la red del usuario).
export async function fetchNearbyFlights(lat, lon, radiusNm = DEFAULT_RADIUS_NM) {
  const qLat = coarseCoord(lat), qLon = coarseCoord(lon);
  const failures = [];

  for (const provider of PROVIDERS) {
    try {
      const data = await fetchJson(provider.url(qLat, qLon, radiusNm));
      return { flights: parseAircraft(data, lat, lon), provider: provider.name };
    } catch (err) {
      failures.push(`${provider.name}: ${err && (err.message || err.name)}`);
    }
  }

  const error = new Error("Ningún proveedor de datos respondió");
  error.failures = failures;
  throw error;
}

export function fmtAltitude(flight) {
  if (flight.onGround) return "En tierra";
  return flight.altitudeM != null ? Math.round(flight.altitudeM) + " m" : "N/A";
}

export function fmtSpeed(flight) {
  return flight.speedKmh != null ? Math.round(flight.speedKmh) + " km/h" : "N/A";
}

// Renderiza la lista de tarjetas de vuelo dentro de `container`. Todo el
// texto de origen externo (callsign) se escapa antes de entrar al HTML.
export function renderFlightList(container, flights, maxItems = 30) {
  if (!flights.length) {
    container.innerHTML = '<div class="empty">No hay vuelos detectados cerca. Intenta actualizar en unos segundos.</div>';
    return;
  }
  container.innerHTML = flights.slice(0, maxItems).map((f) => `
    <div class="flight-card">
      <div class="top">
        <span class="callsign">✈ ${escapeHtml(f.callsign)}</span>
        <span class="dist">${f.dist.toFixed(1)} km</span>
      </div>
      <div class="details">
        <span>Alt: ${fmtAltitude(f)}</span>
        <span>Vel: ${fmtSpeed(f)}</span>
        <span>Dirección: ${bearingLabel(f.brg)}</span>
      </div>
    </div>
  `).join("");
}
