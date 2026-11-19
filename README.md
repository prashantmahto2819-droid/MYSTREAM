# Vivid Stream

Self-hosted multistream relay (Restream-style) for a small office team.

- **Live:** OBS sends one stream in; the server forwards it to many YouTube / Facebook / Twitch / custom RTMP destinations.
- **Recorded:** upload a video (2-5 GB is fine), schedule it for a time (IST), and it goes live on the chosen destinations by itself. Playlist, repeat, 24x7 loop. The file is deleted after the live.
- **Alerts:** WhatsApp message when a live starts, ends, fails or is missed, when OBS disconnects, when a destination drops or gets slow, and when the disk is filling up.
- **Browser studio (no OBS):** go live from the dashboard with camera or screen share, scenes (camera / screen / screen + camera / standby), logo, lower-third, scrolling ticker, tick which destinations to send to, 480p/720p/1080p. Re-encodes on the server (about one CPU core at 720p).
- **Connect YouTube / Facebook:** one-click "Create live" that creates the broadcast and adds the destination with its key.
- **Standby screen:** if OBS drops, a standby slate keeps YouTube/Facebook connected for a few minutes (opt-in).
- **Guests:** invite link; guests join from their browser and appear in your scenes.
- **Look:** drag the small camera/logo/name bar on the preview; background colour/image; green screen; optional AI "remove my room" (blur or replace; installed by the Docker build when it has internet).
- **Record from the studio** and keep the clip under Videos to schedule later.
- **Recordings:** optional copy of your OBS lives (kept 7 days), downloadable, or reusable as a video for a later schedule.
- **Other software:** API keys + a ready client (`client/`, `docs/API.md`) so Vividora can upload a finished render and schedule it.

Stack: [MediaMTX](https://github.com/bluenviron/mediamtx) (RTMP ingest), `ffmpeg -c copy` relays (no re-encoding, so 1080p/4K pass through and CPU stays low), zero-dependency Node.js 22 app (built-in `node:sqlite`), vanilla-JS dashboard.

## What is included

| Area | Features |
|---|---|
| Team | Login, admin/operator roles, each user has their own OBS stream key and destinations, activity log |
| Destinations | Presets for YouTube, Facebook, Twitch, custom RTMP(S); stream keys stored AES-256-GCM encrypted and never sent back to the browser; On/Off while live |
| Live relay | One ffmpeg per destination, auto-restart with backoff, one failing destination never affects the others, errors shown in the dashboard |
| Videos | Resumable chunked upload (survives network drops, works through Cloudflare), storage quota and free-space checks, automatic check of every upload |
| Preparation | Video is re-encoded **only if needed** (not H.264/AAC, keyframes too far apart, no audio track), one at a time |
| Schedule | Date/time in your local time, playlist (same resolution/fps), repeat 1-50 or until stopped, pick destinations, auto-delete, cancel/stop, overlap protection, late-start protection |
| Live health | Bitrate and speed per destination in the dashboard; alert if a destination cannot keep up |
| Alerts | Generic webhook (works with Vivid Relay), per-user number + office numbers, cooldown so a flapping stream does not spam; OBS started/dropped, slow destination, disk low |
| Recordings | Per-user "Record my OBS lives" switch, Matroska copy (crash-safe), ranged download, "Use as video", auto-removed after `RECORDING_KEEP_DAYS` |
| API | `Authorization: Bearer vs_...` keys (hashed in the database, revocable, limited powers) and `client/vivid-stream-client.mjs` with resumable upload |
| Account | Change password (signs out other devices), API keys, WhatsApp number |
| Safety | CSRF header, login rate limit, strict CSP, private/internal destination URLs rejected, MediaMTX connections authorised by the app |

## How it works

```
OBS ──rtmp──▶ MediaMTX ◀── ffmpeg (copy) ──▶ YouTube channel 1
(live/<key>)      ▲  ▲     ffmpeg (copy) ──▶ YouTube channel 2
                  │  │     ffmpeg (copy) ──▶ Facebook page
                  │  └── ffmpeg (copy, concat playlist) ◀── uploaded videos  (scheduled live)
        app polls the MediaMTX API every 2s: stream appears → start relays, stream drops → stop relays
```

A scheduled live publishes into MediaMTX exactly like OBS would, so the same relay code sends it everywhere, and the connection to YouTube/Facebook is not interrupted between playlist items.

---

## Setup, step by step (about 30 minutes)

You need: the Hetzner server with Docker, your domain on Cloudflare, this code in your GitHub repo.

### 1. Put the code on the server
1. Push this folder to your repo.
2. SSH into the Hetzner server and check Docker: `docker --version && docker compose version` (install guide if missing: https://docs.docker.com/engine/install/ubuntu/).
3. Clone: `git clone https://github.com/<you>/<repo>.git /srv/vivid-stream && cd /srv/vivid-stream`

### 2. Configure
1. `cp .env.example .env && nano .env`
2. `APP_SECRET`: paste the output of `openssl rand -hex 32`. **Keep a copy somewhere safe**, because if it is lost the saved stream keys cannot be read.
3. `PUBLIC_RTMP_URL=rtmp://rtmp.vividbrandify.com/live`
4. `ADMIN_EMAIL` and `ADMIN_PASSWORD`: your first login.

### 2b. More disk with a Hetzner Volume (recommended, 2 minutes)
The server has a 40 GB disk shared with Vivid Relay; 2-5 GB videos fill it quickly.
1. https://console.hetzner.cloud/ → your server → **Volumes** → Create Volume: same location, 100 GB, ext4, **Automatic mount**.
2. On the server: `df -h | grep HC_Volume` and note the path, e.g. `/mnt/HC_Volume_12345678`.
3. `mkdir -p /mnt/HC_Volume_12345678/vivid-stream` and put `DATA_PATH=/mnt/HC_Volume_12345678/vivid-stream` in `.env`.

### 3. DNS (Cloudflare)
1. Open https://dash.cloudflare.com/ → your domain → DNS → Records.
2. Add an **A** record: name `rtmp`, value = the server IP, **Proxy status: DNS only (grey cloud)**. Cloudflare's proxy does not carry RTMP.

### 4. Open the RTMP port (Hetzner)
1. Open https://console.hetzner.cloud/ → your project → Firewalls (or the server's Firewall tab).
2. Allow inbound **TCP 1935**. Do not open 3000 or 9997.
3. If the server uses `ufw`: `sudo ufw allow 1935/tcp`

### 5. Start it
```bash
docker compose up -d --build
docker compose logs -f        # Ctrl+C to leave; expect "Created first admin" and "vivid-stream listening"
```
If `mediamtx` shows an `authHTTPExclude` warning, send me the log line.

### 6. Dashboard with HTTPS (Cloudflare Tunnel)
The dashboard listens on `127.0.0.1:3000` only. Publish it through a tunnel:
1. https://one.dash.cloudflare.com/ → Networks → Tunnels → create (or reuse) a tunnel and install `cloudflared` on the server as shown on that page. Guide: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/
2. Add a **Public hostname**: `live.vividbrandify.com` → Service `HTTP` → `localhost:3000`.
3. Open `https://live.vividbrandify.com` and sign in.

Uploads work through Cloudflare even on the free plan, because the browser sends the video in 8 MB pieces (the 100 MB request limit does not matter).

### 7. Team and alerts
1. Dashboard → Team → add your 5-6 colleagues (they set their own WhatsApp number on their dashboard).
2. WhatsApp alerts: in `.env` set `ALERT_WEBHOOK_URL` to the "send message" URL of Vivid Relay, `ALERT_WEBHOOK_AUTH` if it needs a token, and adjust `ALERT_BODY_TEMPLATE` so the JSON field names match what that endpoint expects. Add `ALERT_TO` for the office numbers that should get every alert. Then `docker compose up -d` again.

### 7b. Vividora / other software (optional)
Dashboard → Settings → **Create API key** (copied once). Then follow `docs/API.md`; the client does upload + schedule in three lines.

### 8. Test before the real event
1. YouTube Studio → Create → Go live → **Stream** → copy Stream URL + key, set visibility **Unlisted** (https://studio.youtube.com/). Live must be enabled on the channel (up to 24 hours the first time).
2. Dashboard → Add destination (YouTube preset) → paste the key.
3. OBS → Settings → Stream → Service **Custom**: Server = `rtmp://rtmp.vividbrandify.com/live`, Stream key = the one shown in the dashboard. Start Streaming. Within ~3 seconds the destination turns **Live**.
4. Facebook: Live Producer → "Use a persistent stream key" → use the Facebook preset and paste the key.
5. Scheduled video: upload a 1-2 minute clip, schedule it 5 minutes ahead, watch it go live, confirm the file disappears afterwards.
6. Pull the network cable on OBS or stop streaming and check the alert arrives.

### Updating later
```bash
cd /srv/vivid-stream && git pull && docker compose up -d --build
```
Back up `./data` regularly (database + stored videos): `tar czf backup-$(date +%F).tgz data/`.

---

## Good to know

- **Bandwidth:** every destination re-sends the incoming bitrate. 6 Mbps video × 5 destinations = 30 Mbps upload.
- **4K:** works in copy mode if the destination accepts it (YouTube does; Facebook and Twitch generally do not and would need transcoding, which this version does not do).
- **Playlist rule:** videos in one schedule must have the same size and frame rate, otherwise schedule them separately.
- **Facebook:** use a *persistent* stream key. **YouTube:** one stream key allows a limited number of simultaneous streams.
- **One stream key = one live at a time.** If OBS is live, a scheduled video on the same key will not start (you get an alert).
- **Server restart during a live** cuts it; the schedule is marked failed and you are alerted.
- Changing `APP_SECRET` makes saved stream keys unreadable.
- Run the tests: `npm test` (Node 22.5+, needs ffmpeg for the media tests).

## Connect YouTube / Facebook (optional)

This lets you press "Create live" in the dashboard and get the stream key made for you. Without it everything else works; you just paste keys by hand.

Set in `.env`: `PUBLIC_BASE_URL=https://live.vividbrandify.com`, then the keys below, then `docker compose up -d`.

**YouTube (Google)**
1. https://console.cloud.google.com/projectcreate - create a project.
2. https://console.cloud.google.com/apis/library/youtube.googleapis.com - **Enable** "YouTube Data API v3".
3. https://console.cloud.google.com/auth/overview - set up the consent screen (External). Add your Google email under **Audience -> Test users**, then press **Publish app** (otherwise tokens stop after 7 days; the "unverified app" warning on sign-in is normal for your own team).
4. https://console.cloud.google.com/auth/clients - **Create client -> Web application**. Authorised redirect URI: `https://live.vividbrandify.com/api/oauth/google/callback`.
5. Put the Client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. The YouTube channel must be enabled for live streaming (https://www.youtube.com/features, up to 24 hours the first time).

**Facebook Pages**
1. https://developers.facebook.com/apps - **Create app** (type Business).
2. Add the product **Facebook Login for Business** (or Facebook Login) and set Valid OAuth Redirect URI: `https://live.vividbrandify.com/api/oauth/facebook/callback`.
3. Put App ID and App Secret in `.env` as `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
4. While the app is in Development mode only people added under App roles can connect, which is enough for your office. Going public needs Facebook app review. Only Pages can be created this way, not personal profiles.

Then in the dashboard: **Destinations -> Connect YouTube** (or Facebook Page), sign in, press **Create live**.
YouTube lives made this way start automatically when video arrives and end when you stop.

## Updating a running server

```
cd /srv/vivid-stream && git pull
docker compose up -d --build
```

If the app restarts with "unable to open database file", the data folder belongs to root: `chown -R 1000:1000 <DATA_PATH>`.

## Roadmap

1. Vividora side: the "Schedule Live" button (how: docs/VIVIDORA.md)
2. Destination groups, per-destination bitrate history
3. Guest return video, Instagram and X destinations

## Studio extras (ManyCam / Restream style)

- Camera and microphone pickers, audio mixer (volume and mute per source), mirror and brightness/contrast/colour filters.
- Media scene: play videos, photos and slides from your computer (arrow keys for next/previous).
- Countdown timer or clock, drawing on screen, PNG snapshot, hotkeys (1-7 scenes, D drawing).
- Destination groups, presets (Kick, Instagram, X, LinkedIn), bitrate sparklines, guest return video.
- Live chat panel: YouTube (via a connected channel) and Twitch (read-only); press Show to put a message on the stream. Facebook chat is not supported.
- A ManyCam-style virtual webcam cannot be made from a browser. Use OBS Virtual Camera or a separate native app for that.
- Modern dark UI (glass cards, gradient tabs).

### Multi-source studio
- Several cameras (+ Another camera, choose which is main, "All cameras" scene) and several microphones, each with a level meter, volume and mute in the mixer.
- Up to 8 guests. "Host + guests" scene auto-sizes the grid; 4 or fewer is smoother.
- Speaker scene: one person big, others in a side strip. Auto picks whoever is talking (with a green ring), or choose a person manually.
- Clip list: play any clip on live, optionally with your camera small on top, loop or return to the previous scene when it ends.
- Backgrounds: colour, image or gradients. To see the background behind you, turn on "Remove my room (AI)" or green screen.

### Restream-style extras
- Portrait (9:16) or Landscape output, Side-by-side layout, Countdown scene (auto-switches to camera at 00:00), saved scenes (stored in your browser).
- Themes (Air, Base, News, Round) and fonts for lower-third, ticker, timer and chat messages; camera filters, touch-up, overlay frame PNG.
- Background music with volume in the mixer, live captions (Hindi / English, Chrome or Edge), private notes with teleprompter scroll.
- More destination presets: TikTok, Rumble, Amazon Live, Telegram (paste the server URL they give you).
- Not built: QR codes, webinar pages, analytics, AI music.
