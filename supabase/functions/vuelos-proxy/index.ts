// Edge Function: intermediario propio para los datos ADS-B.
//
// Las APIs públicas de vuelos no mandan el header Access-Control-Allow-Origin,
// así que el navegador no puede leerlas directo desde la app (Safari lo
// reporta como "Load failed"). Los reenvíos CORS gratuitos resolvían eso pero
// resultaron poco fiables: allorigins se pone lentísimo, corsproxy empezó a
// exigir llave de API (HTTP 401) y codetabs se cae.
//
// Esta función corre del lado servidor, donde CORS no aplica, y devuelve la
// respuesta con los headers correctos para la app.
//
// No es un proxy abierto: solo acepta lat/lon/dist y solo consulta los tres
// hosts de la lista de abajo, así que no sirve para alcanzar ningún otro
// destino. Por eso no exige JWT — sirve datos públicos de solo lectura.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGINS = [
  "https://pepito42069.github.io",
  "http://localhost:8099",
];

const UPSTREAMS = [
  { name: "adsb.lol", url: (lat: number, lon: number, d: number) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${d}` },
  { name: "adsb.fi", url: (lat: number, lon: number, d: number) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}` },
  { name: "airplanes.live", url: (lat: number, lon: number, d: number) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${d}` },
];

const UPSTREAM_TIMEOUT_MS = 6000;
// Si el proveedor principal no contestó en este tiempo, se lanzan los otros
// dos en paralelo y gana el primero que responda. En el caso normal (el
// principal contesta rápido) los otros nunca llegan a salir, así que no se
// triplica la carga sobre servicios que son gratuitos y comunitarios.
const HEDGE_MS = 700;

type Aircraft = Record<string, unknown>;

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Los proveedores devuelven 40+ campos por aeronave (ias, tas, mach, squawk,
// nav_*, mlat, tisb, rssi...). La app usa ocho. Recortar aquí, en el servidor,
// baja el payload que viaja al celular alrededor de un 80%.
function trimAircraft(raw: unknown): Aircraft[] {
  if (!Array.isArray(raw)) return [];
  const out: Aircraft[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const ac = a as Aircraft;
    if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
    out.push({
      hex: ac.hex, flight: ac.flight, lat: ac.lat, lon: ac.lon,
      alt_baro: ac.alt_baro, alt_geom: ac.alt_geom, gs: ac.gs, track: ac.track,
    });
  }
  return out;
}

async function fetchUpstream(url: string, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, timeout]),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Petición con cobertura: sale el principal y, si se demora, los suplentes.
// Gana el primero que responda y se aborta el resto.
async function fetchFastest(lat: number, lon: number, dist: number) {
  const controller = new AbortController();
  const attempt = async (u: typeof UPSTREAMS[number]) => ({
    source: u.name,
    data: await fetchUpstream(u.url(lat, lon, dist), controller.signal),
  });

  const carreras = [
    attempt(UPSTREAMS[0]),
    ...UPSTREAMS.slice(1).map((u) => sleep(HEDGE_MS).then(() => attempt(u))),
  ];

  try {
    return await Promise.any(carreras);
  } finally {
    controller.abort(); // corta las que sigan en vuelo
  }
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return jsonResponse({ error: "Solo se permite GET" }, 405, cors);

  const params = new URL(req.url).searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  const dist = Number(params.get("dist") ?? 100);

  // Validación estricta: sin esto, los valores entrarían tal cual en la URL
  // del proveedor.
  const valido = Number.isFinite(lat) && Math.abs(lat) <= 90
    && Number.isFinite(lon) && Math.abs(lon) <= 180
    && Number.isFinite(dist) && dist >= 1 && dist <= 250;
  if (!valido) {
    return jsonResponse({ error: "Parámetros inválidos: se espera lat (-90..90), lon (-180..180), dist (1..250)" }, 400, cors);
  }

  try {
    const { source, data } = await fetchFastest(lat, lon, dist);
    const ac = trimAircraft((data as { ac?: unknown })?.ac);
    return jsonResponse({ ac, source, now: Date.now() }, 200, cors);
  } catch (err) {
    const fallos = err instanceof AggregateError
      ? err.errors.map((e: Error, i: number) => `${UPSTREAMS[i]?.name ?? "?"}: ${e?.message ?? "error"}`)
      : [String((err as Error)?.message ?? err)];
    return jsonResponse({ error: "Ningún proveedor respondió", failures: fallos }, 502, cors);
  }
});
