const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DIG Proxy v4 - Spotify + Bandcamp' });
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

// ── SPOTIFY TOKEN ──
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials not configured.');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Spotify auth failed: ' + JSON.stringify(data));
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

// ── SPOTIFY SEARCH ──
async function searchSpotify(q) {
  try {
    const token = await getSpotifyToken();
    const resp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=50&market=US`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await resp.json();
    if (data.error) return [];
    let tracks = (data.tracks?.items || []).map(t => ({
      id: 'sp_' + t.id,
      name: t.name,
      preview_url: t.preview_url || null,
      stream_url: t.preview_url || null,
      duration_ms: t.duration_ms,
      popularity: t.popularity,
      source: 'spotify',
      artists: t.artists.map(a => ({ name: a.name })),
      album: {
        name: t.album?.name,
        release_date: t.album?.release_date,
        images: t.album?.images?.slice(0, 1)
      },
      external_urls: t.external_urls
    }));
    // Sort: preview tracks first, then by ascending popularity
    tracks.sort((a, b) => {
      if (a.preview_url && !b.preview_url) return -1;
      if (!a.preview_url && b.preview_url) return 1;
      return (a.popularity || 50) - (b.popularity || 50);
    });
    return tracks.slice(0, 10);
  } catch (e) {
    console.error('Spotify search error:', e.message);
    return [];
  }
}

// ── BANDCAMP SEARCH ──
async function searchBandcamp(q) {
  try {
    const url = `https://bandcamp.com/search?q=${encodeURIComponent(q)}&item_type=t`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DIG-music-discovery/1.0)',
        'Accept': 'text/html'
      }
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const tracks = [];
    // Parse search result items
    const itemRegex = /<li class="searchresult track"[\s\S]*?<\/li>/g;
    const items = html.match(itemRegex) || [];

    for (const item of items.slice(0, 15)) {
      try {
        // Extract title
        const titleMatch = item.match(/class="heading"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
        const title = titleMatch ? titleMatch[1].trim() : null;
        if (!title) continue;

        // Extract artist
        const artistMatch = item.match(/class="subhead"[^>]*>([\s\S]*?)<\/div>/);
        const artistRaw = artistMatch ? artistMatch[1] : '';
        const artist = artistRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^by\s*/i, '').trim();

        // Extract URL
        const urlMatch = item.match(/class="itemurl"[^>]*>\s*<a[^>]*href="([^"]+)"/);
        const trackUrl = urlMatch ? urlMatch[1].trim() : null;

        // Extract album art
        const imgMatch = item.match(/class="art"[\s\S]*?<img[^>]+src="([^"]+)"/);
        const imageUrl = imgMatch ? imgMatch[1].replace('-_-', '-10-') : null;

        // Extract genre/tags
        const genreMatch = item.match(/class="genre"[^>]*>([^<]+)</);
        const genre = genreMatch ? genreMatch[1].trim() : 'Independent';

        if (title && artist) {
          tracks.push({
            id: 'bc_' + Buffer.from(title + artist).toString('base64').slice(0, 12),
            name: title,
            artist_name: artist,
            preview_url: null, // fetched per-track when user presses play
            stream_url: null,
            bandcamp_url: trackUrl,
            source: 'bandcamp',
            popularity: 10, // default low - emerging artists
            artists: [{ name: artist }],
            album: {
              name: '',
              release_date: '',
              images: imageUrl ? [{ url: imageUrl }] : []
            },
            external_urls: { spotify: null, bandcamp: trackUrl },
            genre: genre
          });
        }
      } catch (e) { continue; }
    }
    return tracks;
  } catch (e) {
    console.error('Bandcamp search error:', e.message);
    return [];
  }
}

// ── BANDCAMP TRACK STREAM URL ──
// Fetches the actual streamable MP3 URL from a Bandcamp track page
app.get('/bandcamp-stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('bandcamp.com')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DIG-music-discovery/1.0)' }
    });
    if (!resp.ok) return res.status(404).json({ error: 'Track page not found' });
    const html = await resp.text();

    // Extract stream URL from TralbumData
    const streamMatch = html.match(/"mp3-128":"([^"]+)"/);
    if (streamMatch) {
      const streamUrl = streamMatch[1].replace(/\\/g, '');
      return res.json({ stream_url: streamUrl });
    }

    // Try alternate format
    const altMatch = html.match(/stream_url['":\s]+"([^"]+\.mp3[^"]*)/);
    if (altMatch) {
      return res.json({ stream_url: altMatch[1] });
    }

    res.json({ stream_url: null, message: 'No stream found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── COMBINED SEARCH (Spotify + Bandcamp) ──
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    // Run both searches in parallel
    const [spotifyTracks, bandcampTracks] = await Promise.all([
      searchSpotify(q),
      searchBandcamp(q)
    ]);

    // Interleave results - mix sources together
    const mixed = [];
    const maxLen = Math.max(spotifyTracks.length, bandcampTracks.length);
    for (let i = 0; i < maxLen; i++) {
      if (bandcampTracks[i]) mixed.push(bandcampTracks[i]); // Bandcamp first (more likely emerging)
      if (spotifyTracks[i]) mixed.push(spotifyTracks[i]);
    }

    res.json({
      tracks: mixed,
      sources: {
        spotify: spotifyTracks.length,
        bandcamp: bandcampTracks.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DIG Proxy v4 - Spotify + Bandcamp on port ${PORT}`));
