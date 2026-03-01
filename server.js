const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DIG Proxy v7',
    spotify_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    anthropic_set: !!process.env.ANTHROPIC_API_KEY,
    soundcloud_id_set: !!process.env.SOUNDCLOUD_CLIENT_ID,
    soundcloud_secret_set: !!process.env.SOUNDCLOUD_CLIENT_SECRET
  });
});

app.post('/claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: req.body.model || 'claude-sonnet-4-20250514', max_tokens: req.body.max_tokens || 4096, messages: req.body.messages })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPOTIFY ────────────────────────────────────────────────────────────────

let spToken = null, spExpiry = 0;
async function getSpotifyToken() {
  if (spToken && Date.now() < spExpiry) return spToken;
  const id = process.env.SPOTIFY_CLIENT_ID, sec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !sec) throw new Error('Spotify credentials not set');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(id+':'+sec).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Spotify auth failed: ' + d.error_description);
  spToken = d.access_token;
  spExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return spToken;
}

async function searchSpotify(q) {
  const token = await getSpotifyToken();
  async function doSearch(query) {
    const r = await fetch(
      'https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=track&limit=10&market=US',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const d = await r.json();
    if (d.error) throw new Error('Spotify: ' + d.error.message);
    return d.tracks?.items || [];
  }
  let items = await doSearch(q);
  if (items.length === 0) {
    const simplified = q.split(' ').slice(0, 3).join(' ');
    if (simplified !== q) items = await doSearch(simplified);
  }
  let tracks = items.map(t => ({
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
  tracks.sort((a, b) => {
    if (a.preview_url && !b.preview_url) return -1;
    if (!a.preview_url && b.preview_url) return 1;
    return (a.popularity || 50) - (b.popularity || 50);
  });
  return tracks.slice(0, 10);
}

// ─── SOUNDCLOUD ──────────────────────────────────────────────────────────────
// FIX: SoundCloud now requires OAuth2 client_credentials flow — NOT client_id in URL.
// You need BOTH SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET in Render env vars.
// Get them at: https://soundcloud.com/you/apps

let scToken = null, scExpiry = 0;
async function getSoundCloudToken() {
  if (scToken && Date.now() < scExpiry) return scToken;
  const id = process.env.SOUNDCLOUD_CLIENT_ID;
  const sec = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!id || !sec) throw new Error('SoundCloud credentials not set');
  const r = await fetch('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json; charset=utf-8' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }).toString()
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('SoundCloud auth failed (' + r.status + '): ' + txt.slice(0, 200));
  }
  const d = await r.json();
  if (!d.access_token) throw new Error('SoundCloud auth: no token returned');
  scToken = d.access_token;
  scExpiry = Date.now() + ((d.expires_in || 3600) - 60) * 1000;
  return scToken;
}

// Resolves a SoundCloud transcoding URL into a playable CDN stream URL.
// Frontend calls: GET /soundcloud-stream?url=<transcoding_url>
app.get('/soundcloud-stream', async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl || !streamUrl.includes('soundcloud')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const token = await getSoundCloudToken();
    const r = await fetch(streamUrl, {
      headers: { 'Authorization': 'OAuth ' + token, 'Accept': 'application/json; charset=utf-8' },
      redirect: 'follow'
    });
    if (!r.ok) return res.status(502).json({ error: 'SoundCloud stream fetch failed: ' + r.status });
    const d = await r.json();
    res.json({ stream_url: d.url || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function searchSoundCloud(q) {
  try {
    const token = await getSoundCloudToken();
    const r = await fetch(
      'https://api.soundcloud.com/tracks?q=' + encodeURIComponent(q) + '&limit=10',
      { headers: { 'Authorization': 'OAuth ' + token, 'Accept': 'application/json; charset=utf-8' } }
    );
    if (!r.ok) {
      console.error('SoundCloud search failed:', r.status, await r.text().catch(()=>''));
      return [];
    }
    const items = await r.json();
    if (!Array.isArray(items)) return [];

    return items
      .filter(t => t.streamable)
      .map(t => {
        // FIX: Use urn (string) instead of deprecated numeric id
        const uid = t.urn || ('sc_' + (t.id || Math.random().toString(36).slice(2)));
        return {
          id: 'sc_' + uid.replace(/[^a-zA-Z0-9]/g, '_'),
          name: t.title,
          preview_url: null,
          // stream_url is the direct mp3 stream — use Authorization header via /soundcloud-stream
          stream_url: t.stream_url || null,
          duration_ms: t.duration || 0,
          popularity: t.playback_count ? Math.min(Math.floor(t.playback_count / 1000), 100) : 10,
          source: 'soundcloud',
          artists: [{ name: t.user?.username || 'Unknown' }],
          album: {
            name: '',
            release_date: t.created_at?.slice(0, 10) || '',
            images: t.artwork_url ? [{ url: t.artwork_url.replace('-large', '-t300x300') }] : []
          },
          external_urls: { soundcloud: t.permalink_url }
        };
      })
      .slice(0, 10);
  } catch(e) {
    console.error('SoundCloud search error:', e.message);
    return [];
  }
}

// SoundCloud v1 stream endpoint requires Authorization header, not client_id param.
// This proxy endpoint fetches the stream and either redirects or returns the URL.
app.get('/soundcloud-stream-v1', async (req, res) => {
  const streamUrl = req.query.url; // e.g. https://api.soundcloud.com/tracks/123/stream
  if (!streamUrl) return res.status(400).json({ error: 'Missing url' });
  try {
    const token = await getSoundCloudToken();
    const r = await fetch(streamUrl, {
      headers: { 'Authorization': 'OAuth ' + token },
      redirect: 'manual' // SoundCloud redirects to CDN
    });
    // SoundCloud returns 302 to actual CDN mp3
    const location = r.headers.get('location');
    if (location) return res.json({ stream_url: location });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      return res.json({ stream_url: d?.url || null });
    }
    res.status(502).json({ error: 'SC stream error: ' + r.status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── BANDCAMP ────────────────────────────────────────────────────────────────

async function searchBandcamp(q) {
  try {
    const r = await fetch('https://bandcamp.com/search?q=' + encodeURIComponent(q) + '&item_type=t', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!r.ok) return [];
    const html = await r.text();
    const tracks = [];
    const items = html.match(/<li class="searchresult track"[\s\S]*?(?=<li class="searchresult|<\/ul>)/g) || [];
    for (const item of items.slice(0, 10)) {
      try {
        const title = (item.match(/class="heading"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/)||[])[1]?.trim();
        const artistRaw = (item.match(/class="subhead"[^>]*>([\s\S]*?)<\/div>/)||[])[1]||'';
        const artist = artistRaw.replace(/<[^>]+>/g,'').replace(/^\s*by\s*/i,'').trim();
        const trackUrl = (item.match(/class="itemurl"[^>]*>\s*<a[^>]*href="([^"]+)"/)||[])[1]?.trim();
        const imgMatch = item.match(/<img[^>]+src="([^"]+)"[^>]*class="art"|class="art"[^>]*>\s*<img[^>]+src="([^"]+)"/);
        const img = imgMatch ? (imgMatch[1]||imgMatch[2]) : null;
        if (title && artist && trackUrl) tracks.push({
          id: 'bc_' + Buffer.from((title+artist).slice(0,20)).toString('base64').slice(0,12),
          name: title,
          preview_url: null,
          duration_ms: 0,
          popularity: 5,
          source: 'bandcamp',
          artists: [{ name: artist }],
          album: { name: '', release_date: '', images: img ? [{ url: img }] : [] },
          external_urls: { bandcamp: trackUrl },
          bandcamp_url: trackUrl
        });
      } catch(e) { continue; }
    }
    return tracks;
  } catch(e) { return []; }
}

app.get('/bandcamp-stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('bandcamp.com')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await r.text();
    const m = html.match(/"mp3-128":"([^"]+)"/);
    res.json({ stream_url: m ? m[1].replace(/\\/g,'') : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SEARCH (combined) ───────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Missing query' });

  const [sp, bc, sc] = await Promise.allSettled([
    searchSpotify(req.query.q),
    searchBandcamp(req.query.q),
    searchSoundCloud(req.query.q)
  ]);

  const spTracks = sp.status === 'fulfilled' ? sp.value : [];
  const bcTracks = bc.status === 'fulfilled' ? bc.value : [];
  const scTracks = sc.status === 'fulfilled' ? sc.value : [];

  // SC and BC first (have real audio), Spotify capped at 3 (metadata/links only)
  const mixed = [
    ...scTracks,
    ...bcTracks,
    ...spTracks.slice(0, 3)
  ];

  res.json({
    tracks: mixed,
    sources: { spotify: spTracks.length, bandcamp: bcTracks.length, soundcloud: scTracks.length },
    errors: {
      spotify: sp.status === 'rejected' ? sp.reason.message : null,
      bandcamp: bc.status === 'rejected' ? bc.reason.message : null,
      soundcloud: sc.status === 'rejected' ? sc.reason.message : null
    }
  });
});

app.listen(PORT, () => console.log('DIG Proxy v7 on port ' + PORT));
