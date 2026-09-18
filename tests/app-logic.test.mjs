// Pruebas de app-logic.js sin navegador: parser, cadena de proveedores,
// formateo y escape de HTML.
import assert from "node:assert/strict";
import {
  parseAircraft, fetchNearbyFlights, coarseCoord, fmtAltitude, fmtSpeed,
  bearingLabel, escapeHtml, haversineKm, PROVIDERS, CORS_PROXIES, buildAttempts,
} from "../app-logic.js";

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok  -", name); passed++; }
  catch (e) { console.log("  FAIL-", name, "\n      ", e.message); process.exitCode = 1; }
};

const BOG = { lat: 4.65, lon: -74.05 };

// Respuesta realista en formato readsb/tar1090 v2.
const sample = {
  now: 1750000000,
  ac: [
    { hex: "0a1b2c", flight: "AVA123  ", lat: 4.70, lon: -74.10, alt_baro: 35000, gs: 450, track: 270 },
    { hex: "0d4e5f", flight: "LAN500", lat: 4.66, lon: -74.06, alt_baro: "ground", gs: 12, track: 90 },
    { hex: "0f6a7b", flight: "NOALT", lat: 4.80, lon: -74.20, alt_geom: 12000, gs: 300, track: 45 },
    { hex: "0c8d9e", flight: "NOPOS" }, // sin posición: debe filtrarse
    { hex: "0e1f2a", lat: 5.10, lon: -74.50 }, // sin callsign ni datos
  ],
};

console.log("\nparseAircraft");
check("filtra aviones sin posición", () => {
  assert.equal(parseAircraft(sample, BOG.lat, BOG.lon).length, 4);
});
check("ordena por distancia ascendente", () => {
  const d = parseAircraft(sample, BOG.lat, BOG.lon).map((f) => f.dist);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
});
check("convierte pies a metros", () => {
  const f = parseAircraft(sample, BOG.lat, BOG.lon).find((x) => x.callsign === "AVA123");
  assert.equal(Math.round(f.altitudeM), 10668); // 35000 ft
});
check("convierte nudos a km/h", () => {
  const f = parseAircraft(sample, BOG.lat, BOG.lon).find((x) => x.callsign === "AVA123");
  assert.equal(Math.round(f.speedKmh), 833); // 450 kt
});
check("marca aviones en tierra", () => {
  const f = parseAircraft(sample, BOG.lat, BOG.lon).find((x) => x.callsign === "LAN500");
  assert.equal(f.onGround, true);
  assert.equal(f.altitudeM, null);
  assert.equal(fmtAltitude(f), "En tierra");
});
check("usa alt_geom cuando falta alt_baro", () => {
  const f = parseAircraft(sample, BOG.lat, BOG.lon).find((x) => x.callsign === "NOALT");
  assert.equal(Math.round(f.altitudeM), 3658); // 12000 ft
});
check("callsign ausente cae a N/A y track a 0", () => {
  const f = parseAircraft(sample, BOG.lat, BOG.lon).find((x) => x.icao24 === "0e1f2a");
  assert.equal(f.callsign, "N/A");
  assert.equal(f.track, 0);
  assert.equal(fmtSpeed(f), "N/A");
});
check("tolera respuesta vacía o malformada", () => {
  assert.deepEqual(parseAircraft({}, 0, 0), []);
  assert.deepEqual(parseAircraft(null, 0, 0), []);
  assert.deepEqual(parseAircraft({ ac: "no-es-array" }, 0, 0), []);
});
check("track no numérico no se propaga al DOM", () => {
  const evil = { ac: [{ hex: "x", flight: "EVIL", lat: 1, lon: 1, track: '0)"><script>alert(1)</script>' }] };
  assert.equal(parseAircraft(evil, 0, 0)[0].track, 0);
});

console.log("\nescapeHtml");
check("escapa payload XSS en callsign", () => {
  const out = escapeHtml('<img src=x onerror="alert(1)">');
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img"));
});

console.log("\ncoarseCoord / cálculos");
check("redondea el centro a ~1 km", () => {
  assert.equal(coarseCoord(4.6534567), 4.65);
  assert.equal(coarseCoord(-74.0512345), -74.05);
});
check("haversine da distancia conocida", () => {
  assert.equal(Math.round(haversineKm(4.65, -74.05, 4.70, -74.10)), 8);
});
check("bearingLabel cubre los 8 rumbos", () => {
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315].map(bearingLabel),
    ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]);
});

console.log("\nfetchNearbyFlights (cadena de proveedores)");
const withFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};
const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });

const asyncCheck = async (name, fn) => {
  try { await fn(); console.log("  ok  -", name); passed++; }
  catch (e) { console.log("  FAIL-", name, "\n      ", e.message); process.exitCode = 1; }
};

await asyncCheck("usa el primer proveedor cuando responde", async () => {
  const calls = [];
  const res = await withFetch(async (url) => { calls.push(url); return jsonResponse(sample); },
    () => fetchNearbyFlights(BOG.lat, BOG.lon));
  assert.equal(res.provider, "adsb.lol");
  assert.equal(calls.length, 1);
  assert.equal(res.flights.length, 4);
});

await asyncCheck("cae al segundo proveedor si el primero falla (CORS/red)", async () => {
  const calls = [];
  const res = await withFetch(async (url) => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError("Load failed");
    return jsonResponse(sample);
  }, () => fetchNearbyFlights(BOG.lat, BOG.lon));
  assert.equal(res.provider, "adsb.fi");
  assert.equal(calls.length, 2);
});

await asyncCheck("cae al tercero si los dos primeros dan error HTTP", async () => {
  let n = 0;
  const res = await withFetch(async () => {
    n++;
    if (n <= 2) return { ok: false, status: 429, json: async () => ({}) };
    return jsonResponse(sample);
  }, () => fetchNearbyFlights(BOG.lat, BOG.lon));
  assert.equal(res.provider, "airplanes.live");
  assert.equal(n, 3);
});

await asyncCheck("si todos fallan lanza error con el detalle de cada intento", async () => {
  await withFetch(async () => { throw new TypeError("Load failed"); }, async () => {
    await assert.rejects(
      () => fetchNearbyFlights(BOG.lat, BOG.lon),
      (err) => {
        assert.equal(err.failures.length, buildAttempts(0, 0, 100, null).length);
        assert.ok(err.failures[0].startsWith("adsb.lol:"));
        // El detalle debe incluir los intentos vía reenvío, no solo los directos.
        assert.ok(err.failures.some((f) => f.includes("vía allorigins")));
        return true;
      });
  });
});

console.log("\nbuildAttempts (directos + reenvíos CORS)");
check("prueba primero los directos y luego los reenvíos", () => {
  const labels = buildAttempts(4.65, -74.05, 100, null).map((a) => a.label);
  assert.deepEqual(labels.slice(0, 3), PROVIDERS.map((p) => p.name));
  assert.equal(labels.length, PROVIDERS.length + CORS_PROXIES.length * 2);
  assert.ok(labels.slice(3).every((l) => l.includes(" vía ")));
});
check("el reenvío lleva la URL del proveedor codificada", () => {
  const proxied = buildAttempts(4.65, -74.05, 100, null).find((a) => a.label === "adsb.lol vía allorigins");
  assert.ok(proxied.url.startsWith("https://api.allorigins.win/raw?url="));
  assert.ok(proxied.url.includes(encodeURIComponent("https://api.adsb.lol/v2/lat/4.65/lon/-74.05/dist/100")));
});
check("la fuente recordada se intenta de primeras", () => {
  const labels = buildAttempts(4.65, -74.05, 100, "adsb.fi vía allorigins").map((a) => a.label);
  assert.equal(labels[0], "adsb.fi vía allorigins");
  assert.equal(labels.length, new Set(labels).size, "no debe duplicar intentos");
});
check("una fuente recordada que ya no existe no rompe el orden", () => {
  const labels = buildAttempts(4.65, -74.05, 100, "proveedor-fantasma").map((a) => a.label);
  assert.equal(labels[0], "adsb.lol");
});

await asyncCheck("si todos los directos fallan, usa el reenvío CORS", async () => {
  const tried = [];
  const res = await withFetch(async (url) => {
    tried.push(url);
    if (!url.includes("allorigins")) throw new TypeError("Load failed");
    return jsonResponse(sample);
  }, () => fetchNearbyFlights(BOG.lat, BOG.lon));
  assert.equal(res.provider, "adsb.lol vía allorigins");
  assert.equal(res.flights.length, 4);
  assert.equal(tried.length, 4); // 3 directos + el primer reenvío
});

await asyncCheck("manda el centro redondeado, no la posición exacta", async () => {
  let url = "";
  await withFetch(async (u) => { url = u; return jsonResponse(sample); },
    () => fetchNearbyFlights(4.6534567, -74.0512345));
  assert.ok(url.includes("/lat/4.65/lon/-74.05/"), url);
  assert.ok(!url.includes("4.6534567"));
});

console.log(`\n${passed} pruebas pasaron\n`);
