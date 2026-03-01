const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DIG Proxy v5', spotify_id_set: !!process.env.SPOTIFY_CLIENT_ID, spotify_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET, anthropic_set: !!process.env.ANTHROPIC_API_KEY });
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

let spToken = null, spExpiry = 0;
async function getToken() {
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

// FIX 1: Changed limit from 20 to 10 to avoid "Invalid limit" error from Spotify
// FIX 2: Added fallback — if a complex query returns 0 results, retry with first 2 words only
async function searchSpotify(q) {
  const token = await getToken();

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

  // FIX 3: If no results, retry with a simplified version of the query (first 2-3 words)
  if (items.length === 0) {
    const simplified = q.split(' ').slice(0, 3).join(' ');
    if (simplified !== q) {
      items = await doSearch(simplified);
    }
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
        if (title && artist && trackUrl) tracks.push({ id: 'bc_'+Buffer.from((title+artist).slice(0,20)).toString('base64').slice(0,12), name: title, preview_url: null, duration_ms: 0, popularity: 5, source: 'bandcamp', artists: [{name:artist}], album: { name:'', release_date:'', images: img?[{url:img}]:[] }, external_urls: {bandcamp:trackUrl}, bandcamp_url: trackUrl });
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

app.get('/search', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Missing query' });
  const [sp, bc] = await Promise.allSettled([ searchSpotify(req.query.q), searchBandcamp(req.query.q) ]);
  const spTracks = sp.status==='fulfilled' ? sp.value : [];
  const bcTracks = bc.status==='fulfilled' ? bc.value : [];
  const mixed = [];
  for (let i = 0; i < Math.max(spTracks.length, bcTracks.length); i++) {
    if (bcTracks[i]) mixed.push(bcTracks[i]);
    if (spTracks[i]) mixed.push(spTracks[i]);
  }
  res.json({ tracks: mixed, sources: { spotify: spTracks.length, bandcamp: bcTracks.length }, errors: { spotify: sp.status==='rejected' ? sp.reason.message : null, bandcamp: bc.status==='rejected' ? bc.reason.message : null } });
});

app.listen(PORT, () => console.log('DIG Proxy v5 on port ' + PORT));
