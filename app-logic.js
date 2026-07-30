// ---------- Lógica de la app (cálculos, datos, render de lista) ----------
// Separado de index.html para mantenibilidad, siguiendo el mismo patrón
// usado en Hacienda Los Alpes.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Cualquier texto que venga de fuera (sobre todo el callsign reportado por
// OpenSky) pasa por aquí antes de tocar innerHTML — evita que un callsign
// con "<script>" o similar se ejecute como HTML.
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

export const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
// Medio-lado de la caja de búsqueda en grados (~1.2° ≈ 130km), igual que el prototipo.
export const DEFAULT_BBOX_DELTA = 1.2;

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

export function buildOpenSkyUrl(lat, lon, delta = DEFAULT_BBOX_DELTA) {
  const params = new URLSearchParams({
    lamin: String(lat - delta),
    lomin: String(lon - delta),
    lamax: String(lat + delta),
    lomax: String(lon + delta),
  });
  return `${OPENSKY_STATES_URL}?${params.toString()}`;
}

// Convierte el array crudo de "states" de OpenSky en objetos de vuelo,
// filtrando los que no traen posición y ordenando por distancia.
export function parseStates(states, userLat, userLon) {
  return (states || [])
    .map((s) => {
      const [icao24, callsign, , , , lon, lat, baroAlt, , velocity, trueTrack] = s;
      if (typeof lat !== "number" || typeof lon !== "number") return null;
      return {
        icao24: typeof icao24 === "string" ? icao24 : "",
        callsign: (typeof callsign === "string" ? callsign.trim() : "") || "N/A",
        lat, lon,
        altitude: typeof baroAlt === "number" ? baroAlt : null,
        velocity: typeof velocity === "number" ? velocity : null,
        track: typeof trueTrack === "number" ? trueTrack : 0,
        dist: haversineKm(userLat, userLon, lat, lon),
        brg: bearingDeg(userLat, userLon, lat, lon),
      };
    })
    .filter((f) => f !== null)
    .sort((a, b) => a.dist - b.dist);
}

// Pide el estado actual de vuelos a OpenSky para un punto y radio dados.
export async function fetchNearbyFlights(lat, lon, delta = DEFAULT_BBOX_DELTA) {
  const res = await fetch(buildOpenSkyUrl(lat, lon, delta));
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return parseStates(data.states, lat, lon);
}

export function fmtAltitude(altitude) {
  return typeof altitude === "number" ? Math.round(altitude) + " m" : "N/A";
}

export function fmtSpeed(velocity) {
  return typeof velocity === "number" ? Math.round(velocity * 3.6) + " km/h" : "N/A";
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
        <span>Alt: ${fmtAltitude(f.altitude)}</span>
        <span>Vel: ${fmtSpeed(f.velocity)}</span>
        <span>Dirección: ${bearingLabel(f.brg)}</span>
      </div>
    </div>
  `).join("");
}
