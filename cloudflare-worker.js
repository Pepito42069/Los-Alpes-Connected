// Worker proxy para la API pública de OpenSky Network.
//
// GitHub Pages es hosting estático puro: no puede esconder credenciales ni
// actuar como intermediario. OpenSky no manda headers CORS en sus respuestas
// para peticiones fetch() desde un origen de navegador, así que el navegador
// bloquea la lectura aunque el servidor responda bien. Este Worker reenvía
// la petición del lado servidor (donde CORS no aplica) y agrega el header
// correcto antes de devolver el JSON a la app.
//
// Despliegue: Cloudflare Dashboard → Workers & Pages → Create → pegar este
// archivo completo → Deploy. Ver instrucciones detalladas en el chat.

const OPENSKY_URL = "https://opensky-network.org/api/states/all";

// Solo el origen de la app puede usar este proxy — evita que se convierta
// en un proxy CORS abierto para cualquier sitio.
const ALLOWED_ORIGIN = "https://pepito42069.github.io";

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const upstreamUrl = new URL(OPENSKY_URL);
    upstreamUrl.search = requestUrl.search;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        headers: { "Accept": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "No se pudo contactar a OpenSky" }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        },
      });
    }

    const body = await upstreamResponse.text();
    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        // Nunca cachear: son posiciones de vuelo en vivo.
        "Cache-Control": "no-store",
      },
    });
  },
};
