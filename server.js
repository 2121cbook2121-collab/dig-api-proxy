const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'DIG Proxy v5',
    spotify_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    anthropic_set: !!process.env.ANTHROPIC_API_KEY,
    spotify_id_length: (process.env.SPOTIFY_CLIENT_ID||'').length,
    spotify_secret_length: (process.env.SPOTIFY_CLIENT_SECRET||'').length
  });
});

// Spotify credentials debug endpoint
app.get('/spotify-test', async (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({ ok: false, error: 'Credentials not set', id_set: !!clientId, secret_set: !!clientSecret });
  }
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const data = await resp.json();
    if (data.access_token) {
      res.json({ ok: true, message: 'Spotify auth working!', token_type: data.token_type, expires_in: data.expires_in });
    } else {
      res.json({ ok: false, error: data.error, error_description: data.error_description });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Claude proxy
app.post('/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || 'claude-sonnet-4-20250514',
        max_tokens: req.body.max_tokens || 4096,
        messages: req.body.messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Spotify token cache
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials not set in environment variables');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Spotify auth failed: ${data.error} - ${data.error_description}`);
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

// Spotify search
async function searchSpotify(q) {
  const token = await getSpotifyToken();
  const resp = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=50&market=US`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (data.error) throw new Error(`Spotify search error: ${data.error.message}`);
  let tracks = (data.tracks?.items || []).map(t => ({
    id: 'sp_' + t.id,
    name: t.name,
    preview_url: t.preview_url || null,
    duration_ms: t.duration_ms,
    popularity: t.popularity,
    source: 'spotify',
    artists: t.artists.map(a => ({ name: a.name })),
    album: { name: t.album?.name, release_date: t.album?.release_date, images: t.album?.images?.slice(0, 1) },
    external_urls: t.external_urls
  }));
  // Sort: preview tracks first, then lowest popularity (most emerging)
  tracks.sort((a, b) => {
    if (a.preview_url && !b.preview_url) return -1;
    if (!a.preview_url && b.preview_url) return 1;
    return (a.popularity || 50) - (b.popularity || 50);
  });
  return tracks.slice(0, 10);
}

// Bandcamp search
async function searchBandcamp(q) {
  try {
    const url = `https://bandcamp.com/search?q=${encodeURIComponent(q)}&item_type=t`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-discovery-bot/1.0)', 'Accept': 'text/html' }
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const tracks = [];
    const itemRegex = /<li class="searchresult track"[\s\S]*?(?=<li class="searchresult|<\/ul>)/g;
    const items = html.match(itemRegex) || [];
    for (const item of items.slice(0, 10)) {
      try {
        const titleMatch = item.match(/class="heading"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
        const title = titleMatch ? titleMatch[1].trim() : null;
        if (!title) continue;
        const artistMatch = item.match(/class="subhead"[^>]*>([\s\S]*?)<\/div>/);
        const artist = artistMatch ? artistMatch[1].replace(/<[^>]+>/g, '').replace(/^\s*by\s*/i, '').trim() : 'Unknown';
        const urlMatch = item.match(/class="itemurl"[^>]*>\s*<a[^>]*href="([^"]+)"/);
        const trackUrl = urlMatch ? urlMatch[1].trim() : null;
        const imgMatch = item.match(/<img[^>]+src="([^"]+)"[^>]*class="art"|class="art"[^>]*>\s*<img[^>]+src="([^"]+)"/);
        const imageUrl = imgMatch ? (imgMatch[1] || imgMatch[2]) : null;
        if (title && artist && trackUrl) {
          tracks.push({
            id: 'bc_' + Buffer.from((title + artist).slice(0, 20)).toString('base64').slice(0, 12),
            name: title,
            preview_url: null,
            duration_ms: 0,
            popularity: 5,
            source: 'bandcamp',
            artists: [{ name: artist }],
            album: { name: '', release_date: '', images: imageUrl ? [{ url: imageUrl }] : [] },
            external_urls: { bandcamp: trackUrl },
            bandcamp_url: trackUrl
          });
        }
      } catch (e) { continue; }
    }
    return tracks;
  } catch (e) {
    console.error('Bandcamp error:', e.message);
    return [];
  }
}

// Bandcamp stream URL fetcher
app.get('/bandcamp-stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('bandcamp.com')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; music-discovery-bot/1.0)' } });
    if (!resp.ok) return res.status(404).json({ error: 'Track not found' });
    const html = await resp.text();
    const streamMatch = html.match(/"mp3-128":"([^"]+)"/);
    if (streamMatch) return res.json({ stream_url: streamMatch[1].replace(/\\/g, '') });
    res.json({ stream_url: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Combined search - Spotify + Bandcamp in parallel
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const [spotifyTracks, bandcampTracks] = await Promise.allSettled([
      searchSpotify(q),
      searchBandcamp(q)
    ]);
    const sp = spotifyTracks.status === 'fulfilled' ? spotifyTracks.value : [];
    const bc = bandcampTracks.status === 'fulfilled' ? bandcampTracks.value : [];
    const spError = spotifyTracks.status === 'rejected' ? spotifyTracks.reason.message : null;
    const bcError = bandcampTracks.status === 'rejected' ? bandcampTracks.reason.message : null;

    // Interleave: Bandcamp first (more emerging), then Spotify
    const mixed = [];
    const maxLen = Math.max(sp.length, bc.length);
    for (let i = 0; i < maxLen; i++) {
      if (bc[i]) mixed.push(bc[i]);
      if (sp[i]) mixed.push(sp[i]);
    }

    res.json({
      tracks: mixed,
      sources: { spotify: sp.length, bandcamp: bc.length },
      errors: { spotify: spError, bandcamp: bcError }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DIG Proxy v5 running on port ${PORT}`));
