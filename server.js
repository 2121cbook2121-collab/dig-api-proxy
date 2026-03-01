const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DIG Proxy — Claude + Spotify' });
});

// ── CLAUDE ──
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

// ── SPOTIFY TOKEN CACHE ──
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials not set');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Failed to get Spotify token: ' + JSON.stringify(data));
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

// ── SPOTIFY SEARCH ──
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query parameter' });
  try {
    const token = await getSpotifyToken();
    const resp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await resp.json();
    const tracks = (data.tracks?.items || []).map(t => ({
      id: t.id,
      name: t.name,
      preview_url: t.preview_url,
      artists: t.artists.map(a => ({ name: a.name })),
      external_urls: t.external_urls
    }));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DIG Proxy running on port ${PORT}`));
