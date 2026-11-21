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

### ManyCam-style camera tools
- Colour mixer: red/green/blue, temperature, tint, hue, brightness/contrast/colour, sharpen, vignette, filters, reset button.
- Layer settings: zoom, move, rotate, mirror/flip, fit/fill/stretch, opacity, corner radius, crop, freeze camera.
- Camera size/fps, echo cancel/noise reduction/auto volume, mic delay (lip-sync), free text and sticker (drag on preview).
- Templates (Business, Education, Gaming, News, Podcast, Interview) and saved scenes.
- A phone can be used as another camera: send it the guest invite link.
- Not built: IP camera input, motion detection, game/desktop capture drivers, virtual webcam (browser limits).
- The page uses a strict CSP: never use inline `style="..."` attributes, use classes in style.css.

### Dashboard layout
- Studio: preview in the middle, scene buttons below it, icon rail on the right (Camera, Clips, Audio, Guests, Scenes, Backdrop, Colour, Position, Graphics, Tools, Chat, Notes) opening one side panel at a time.
- Popups: Go live (destinations + quality), Studio settings (output orientation, camera size), OBS setup, Add destination, Upload video, New schedule, Add team member, API key, Change password.
- Toast messages appear bottom-right (also over popups). On small screens the rail becomes a bar under the preview.

### Browser studio: final extras
- QR code on the stream (own encoder, checked against an independent decoder; link up to about 170 characters, drag to move, optional caption).
- Stats panel (live time, MB sent, bitrate, upload backlog, connection health) and automatic reconnect (3 tries) if the connection to the server drops.
- Vertical templates (Shorts speaker, two people) that also switch the output to Portrait; the chosen quality is remembered.
- Activity tab shows the last 14 days (lives and minutes) from the studio log.
- Still not possible in a browser: virtual webcam, IP camera, motion detection. Facebook comments need extra Facebook permissions and were not built.

### Connect channels from the dashboard
- Destinations > **+ Add channel**: connect YouTube, Facebook Pages (all Pages you manage) or Twitch with one click, or pick any other platform (Instagram, LinkedIn, X, TikTok, Kick, Rumble, Amazon Live, Telegram, Custom) to add it with its RTMP address and stream key.
- The first time, the admin enters the Client ID / secret of the Google, Facebook or Twitch app inside the dashboard (step-by-step guide with links is shown there). They are stored encrypted in the database; you no longer have to edit `.env`. Values in `.env` still work.
- Instagram, LinkedIn, X and TikTok do not offer a public API to create lives, so they stay RTMP only.

## Events: public watch / webinar page

Destinations tab -> **Events** -> "+ New event". You get a public link `https://your-domain/e/<code>` with a countdown,
a registration form (name + email, optional phone) and an embedded player of your YouTube / Twitch / Facebook live.
- The player address is only handed out 10 minutes before the start time. You can add or change the live link later ("Set live link").
- "Download list" gives the registrations as CSV. You get a WhatsApp reminder (Vivid Relay alert) N minutes before the start.
- People who register with a phone number also get the WhatsApp reminder (max 200 per event, sent slowly, 10-digit numbers are taken as +91). Set PUBLIC_BASE_URL so the message carries the link.
- Only YouTube, Twitch and Facebook https links are accepted. Registration is rate-limited per IP. The page has its own CSP that allows only those players.

## Live viewer count

While you are live in the browser studio, the **Stats** panel shows the viewers on your connected YouTube and Twitch channels (refreshed every 20 s,
total plus per channel). Facebook has no simple viewer count, so it is not shown.

The Activity tab's 14-day list also shows the **peak viewers** of each day (recorded when you press Stop in the studio).

## Quality upgrades (from comparing StreamYard / Restream / OBS)
- **Voice polish** (Audio panel): high-pass filter (cuts rumble) + compressor (evens loud and soft speech) on every microphone, plus a **master limiter** so music, clips and several mics never clip.
- **Network guard**: if the upload stays backed up for 10 s while live, the studio restarts itself one quality step lower (1080 -> 720 -> 480) instead of freezing.
- **Captions download**: Tools panel -> Download captions (.srt) or transcript (.txt) of what the live captions heard.
- **Remembers your destinations**: the last ticked destinations are pre-ticked next time.
- **Setup checklist** (Settings tab): plain-language list of what is ready and what to do (engine, channels, site address/https, WhatsApp alerts, phone, recording).

## Backup and calendar
- **Settings -> Download database backup** (admin only): a consistent copy of the database. Videos/recordings are in `./data` (back that folder up too). The file is only readable with your `APP_SECRET`, so keep both safe.
- Event pages have an **Add to calendar** button (.ics with a 15-minute alarm).

## Chat tools (studio -> Live chat)
Hide messages with your own blocked words, hide messages with links (on by default), **auto-show** new messages on the stream one by one (8 s each), message counter and Clear list.

## Change the live title while live
Studio -> Tools -> **Change live title**: pick the connected YouTube or Twitch channel, type the new title (and description for YouTube) and press Update. It changes the live that is running now.

## Home tab
The dashboard now opens on **Home**: OBS live status, destinations on/live, upcoming events and registrations, the next planned events / scheduled video lives, and setup progress.
