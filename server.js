const https = require('https');
const http = require('http');

// ===== CONFIG =====
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const PORT          = process.env.PORT || 3000;

// Simple in-memory token cache
let cachedToken = null;
let tokenExpiry  = 0;

// ===== CORS HEADERS =====
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ===== SPOTIFY TOKEN =====
function fetchSpotifyToken() {
  return new Promise((resolve, reject) => {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body  = 'grant_type=client_credentials';

    const req = https.request({
      hostname: 'accounts.spotify.com',
      path:     '/api/token',
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${creds}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json);
          else reject(new Error(json.error_description || 'Token error'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const data   = await fetchSpotifyToken();
  cachedToken  = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ===== SPOTIFY SEARCH PROXY =====
function spotifySearch(query, token) {
  return new Promise((resolve, reject) => {
    const path = `/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`;
    const req = https.request({
      hostname: 'api.spotify.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ===== SERVER =====
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'DIG Music Proxy' }));
    return;
  }

  // Search endpoint: /search?q=artist+title
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query param q' }));
      return;
    }

    try {
      const token  = await getToken();
      const result = await spotifySearch(q, token);

      // Only return what the app needs — strip excess data
      const tracks = (result.tracks?.items || [])
        .filter(t => t.preview_url)
        .slice(0, 5)
        .map(t => ({
          id:          t.id,
          name:        t.name,
          preview_url: t.preview_url,
          duration_ms: t.duration_ms,
          artists:     t.artists.map(a => ({ name: a.name })),
          album:       { name: t.album.name, images: t.album.images.slice(0,1) },
          external_urls: t.external_urls
        }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tracks }));

    } catch(err) {
      console.error('Search error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`DIG Music Proxy running on port ${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set!');
  }
});
