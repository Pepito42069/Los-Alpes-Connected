// Edge Function: intermediario propio para los datos ADS-B.
//
// Las APIs públicas de vuelos no mandan el header Access-Control-Allow-Origin,
// así que el navegador no puede leerlas directo desde la app (Safari lo
// reporta como "Load failed"). Los reenvíos CORS gratuitos resolvían eso pero
// resultaron poco fiables: allorigins se pone lentísimo, corsproxy empezó a
// exigir llave de API (HTTP 401) y codetabs se cae.
//
// Esta función corre del lado servidor, donde CORS no aplica, prueba los
// proveedores en orden y devuelve el primero que responda, ya con los headers
// correctos para la app.
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

const UPSTREAM_TIMEOUT_MS = 8000;

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

async function fetchUpstream(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
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

  const fallos: string[] = [];
  for (const upstream of UPSTREAMS) {
    try {
      const data = await fetchUpstream(upstream.url(lat, lon, dist));
      return jsonResponse({ ...(data as object), source: upstream.name }, 200, cors);
    } catch (err) {
      fallos.push(`${upstream.name}: ${(err as Error)?.message ?? "error"}`);
    }
  }

  return jsonResponse({ error: "Ningún proveedor respondió", failures: fallos }, 502, cors);
});
