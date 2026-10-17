// ApexMile's Cloudflare Worker.
//
// The app itself is static and lives in app/. This script exists for one
// reason: serving /api/fuel-prices from the same origin. The upstream feed is
// a daily JSON snapshot of Indian district fuel prices; proxying it keeps the
// browser free of CORS surprises and lets Cloudflare cache the response at the
// edge (the feed changes once a day, so 30 minutes is conservative).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/fuel-prices') {
      if (request.method !== 'GET') {
        return json({ status: 'error', message: 'Method not allowed' }, 405);
      }
      try {
        const upstream = await fetch('https://energy.thecore.in/api/india-state-prices', {
          headers: { Accept: 'application/json' },
          cf: { cacheTtl: 1800, cacheEverything: true },
        });
        if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
        return new Response(upstream.body, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=1800',
            'access-control-allow-origin': '*',
            'x-fuel-source': 'energy.thecore.in',
          },
        });
      } catch (err) {
        return json({ status: 'error', message: String(err?.message || err) }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
