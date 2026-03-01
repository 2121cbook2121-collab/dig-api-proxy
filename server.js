const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DIG Proxy v6',
    spotify_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    anthropic_set: !!process.env.ANTHROPIC_API_KEY,
    soundcloud_set: !!process.env.SOUNDCLOUD_CLIENT_ID
  });
});

app.get('/spotify-test', async (req, res) => {
  const id = process.env.SPOTIFY_CLIENT_ID, sec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !sec) return res.json({ ok: false, error: 'Credentials not set' });
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Authorization': 'Basic ' + Buffer.from(id+':'+sec).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const d = await r.json();
    if (d.access_token) res.json({ ok: true, message: 'Spotify auth working!' });
    else res.json({ ok: false, error: d.error, error_description: d.error_description });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: req.body.model || 'claude-sonnet-4-20250514', max_tokens: req.body.max_tokens || 4096, messages: req.body.messages }) });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPOTIFY ────────────────────────────────────────────────────────────────

let spToken = null, spExpiry = 0;
async function getSpotifyToken() {
  if (spToken && Date.now() < spExpiry) return spToken;
  const id = process.env.SPOTIFY_CLIENT_ID, sec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !sec) throw new Error('Spotify credentials not set');
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Authorization': 'Basic ' + Buffer.from(id+':'+sec).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
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

  // Fallback: retry with simplified query if no results
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
    album: {
      name: t.album?.name,
      release_date: t.album?.release_date,
      images: t.album?.images?.slice(0, 1)
    },
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
// Requires SOUNDCLOUD_CLIENT_ID env var.
// Get a free key at: https://soundcloud.com/you/apps (register a new app)

// Proxy endpoint: resolves a SoundCloud transcoding URL into a playable CDN stream URL.
// The frontend should call GET /soundcloud-stream?url=<transcoding_url>
// and then play the returned stream_url directly in an <audio> element.
app.get('/soundcloud-stream', async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl || !streamUrl.includes('soundcloud')) return res.status(400).json({ error: 'Invalid URL' });
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'SOUNDCLOUD_CLIENT_ID not set' });
  try {
    const r = await fetch(streamUrl + '?client_id=' + clientId, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow'
    });
    if (!r.ok) return res.status(502).json({ error: 'SoundCloud stream fetch failed: ' + r.status });
    const d = await r.json();
    res.json({ stream_url: d.url || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function searchSoundCloud(q) {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) return [];
  try {
    const r = await fetch(
      'https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) +
      '&limit=10&access=playable&client_id=' + clientId,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!r.ok) return [];
    const d = await r.json();
    const items = d.collection || [];

    return items
      .filter(t => t.streamable && t.media?.transcodings?.length > 0)
      .map(t => {
        // Prefer progressive (MP3) over HLS for simpler frontend playback
        const transcoding =
          t.media.transcodings.find(x => x.format?.protocol === 'progressive') ||
          t.media.transcodings[0];
        return {
          id: 'sc_' + t.id,
          name: t.title,
          preview_url: null,
          stream_url: transcoding?.url || null, // pass this to /soundcloud-stream?url=<stream_url>
          duration_ms: t.duration || 0,
          popularity: t.playback_count ? Math.min(Math.floor(t.playback_count / 1000), 100) : 10,
          source: 'soundcloud',
          artists: [{ name: t.user?.username || 'Unknown' }],
          album: {
            name: '',
            release_date: t.created_at?.slice(0, 10) || '',
            images: t.artwork_url ? [{ url: t.artwork_url.replace('large', 't300x300') }] : []
          },
          external_urls: { soundcloud: t.permalink_url }
        };
      })
      .slice(0, 10);
  } catch(e) { return []; }
}

// ─── BANDCAMP ────────────────────────────────────────────────────────────────

async function searchBandcamp(q) {
  try {
    const r = await fetch('https://bandcamp.com/search?q=' + encodeURIComponent(q) + '&item_type=t', { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
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
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const m = html.match(/"mp3-128":"([^"]+)"/);
    res.json({ stream_url: m ? m[1].replace(/\\/g,'') : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SEARCH (combined) ───────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Missing query' });

  // Run all three in parallel. SC and BC are the primary sources — Spotify is
  // a fallback for metadata/discovery only (no audio anyway).
  const [sp, bc, sc] = await Promise.allSettled([
    searchSpotify(req.query.q),
    searchBandcamp(req.query.q),
    searchSoundCloud(req.query.q)
  ]);

  const spTracks = sp.status === 'fulfilled' ? sp.value : [];
  const bcTracks = bc.status === 'fulfilled' ? bc.value : [];
  const scTracks = sc.status === 'fulfilled' ? sc.value : [];

  // 1. All SoundCloud tracks first (full streams, best discovery)
  // 2. All Bandcamp tracks next (full streams, indie-focused)
  // 3. Spotify tracks padded in at the end, capped at 3 (metadata/links only)
  const mixed = [
    ...scTracks,
    ...bcTracks,
    ...spTracks.slice(0, 3)
  ];

  res.json({
    tracks: mixed,
    sources: {
      spotify: spTracks.length,
      bandcamp: bcTracks.length,
      soundcloud: scTracks.length
    },
    errors: {
      spotify: sp.status === 'rejected' ? sp.reason.message : null,
      bandcamp: bc.status === 'rejected' ? bc.reason.message : null,
      soundcloud: sc.status === 'rejected' ? sc.reason.message : null
    }
  });
});

app.listen(PORT, () => console.log('DIG Proxy v6 on port ' + PORT));
