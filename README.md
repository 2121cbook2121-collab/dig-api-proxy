# DIG Music Proxy

Secure Spotify API proxy for the DIG music discovery app. Your Client Secret never leaves this server.

## Deploy to Render.com

1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Set these environment variables in Render dashboard:
   - `SPOTIFY_CLIENT_ID` = your Spotify Client ID
   - `SPOTIFY_CLIENT_SECRET` = your Spotify Client Secret
5. Deploy — Render gives you a URL like `https://dig-proxy.onrender.com`
6. Paste that URL into the DIG app settings

## Endpoints

- `GET /health` — check server is running
- `GET /search?q=artist+title` — search Spotify, returns tracks with preview URLs
