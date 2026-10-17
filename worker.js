// ApexMile's Cloudflare Worker.
//
// The app itself is static and lives in app/. This script adds two small,
// cacheable same-origin APIs: a daily fuel-price feed and Photon place search.
// Place queries are coarsely location-biased by the client and cached at the
// edge for five minutes to avoid refetching identical searches.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/places') {
      if (request.method !== 'GET') {
        return json({ status: 'error', message: 'Method not allowed' }, 405);
      }
      const query = String(url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
      if (query.length < 2 || query.length > 120) {
        return json({ status: 'error', message: 'Search query must be 2–120 characters' }, 400);
      }
      const limit = Math.max(1, Math.min(12, Number(url.searchParams.get('limit')) || 8));
      const photonUrl = new URL('https://photon.komoot.io/api/');
      photonUrl.searchParams.set('q', query);
      photonUrl.searchParams.set('limit', String(limit));
      photonUrl.searchParams.set('lang', 'en');
      for (const key of ['lat', 'lon']) {
        const raw = url.searchParams.get(key);
        if (raw == null || raw === '') continue;
        const value = Number(raw);
        if (Number.isFinite(value) && Math.abs(value) <= (key === 'lat' ? 90 : 180)) {
          photonUrl.searchParams.set(key, value.toFixed(2));
        }
      }
      try {
        const upstream = await fetch(photonUrl, {
          headers: { Accept: 'application/geo+json, application/json' },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!upstream.ok) throw new Error(`place provider ${upstream.status}`);
        return new Response(upstream.body, {
          headers: {
            'content-type': 'application/geo+json; charset=utf-8',
            'cache-control': 'public, max-age=300, stale-while-revalidate=600',
            'x-place-source': 'photon',
          },
        });
      } catch (err) {
        return json({ status: 'error', message: String(err?.message || err) }, 502);
      }
    }

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
