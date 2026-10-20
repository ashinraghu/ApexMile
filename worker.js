// Cloudflare Worker for ApexMile PWA & Edge Proxy
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Edge Proxy for Nominatim Geocoding (CORS-friendly, edge-cached)
    if (url.pathname === '/api/places') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&q=${encodeURIComponent(q)}&limit=6`;
        const res = await fetch(nominatimUrl, {
          headers: { 'User-Agent': 'ApexMileApp/2.2 (Cloudflare Worker Edge)' },
          cf: { cacheTtl: 300, cacheEverything: true }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 2. Fallback to Static Asset serving via Cloudflare ASSETS binding
    return env.ASSETS.fetch(request);
  }
};