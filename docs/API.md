# Vivid Stream API

For other software (Vividora, scripts). Create a key in the dashboard: **Settings → API keys**.
Send it on every request: `Authorization: Bearer vs_...` (no cookie and no CSRF header needed).
An API key acts as the user who created it and **cannot** manage keys, passwords, stream keys or team members.

Ready-made client: `client/vivid-stream-client.mjs` (Node 18+, no dependencies).

```js
import { VividStream } from './client/vivid-stream-client.mjs';
const vs = new VividStream({ baseUrl: 'https://live.vividbrandify.com', apiKey: process.env.VIVID_STREAM_KEY });

const dests = await vs.destinations();                                   // [{ id, name, enabled, status, ... }]
const video = await vs.uploadVideo('/data/renders/news.mp4', { title: 'Morning news', onProgress: (p) => console.log(p) });
const live = await vs.scheduleLive({ videoIds: [video.id], startAt: new Date('2026-11-20T18:30:00+05:30'), destIds: [dests[0].id] });
```

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/status` | Ingest info and every destination with `status` (`idle`/`starting`/`live`/`error`), `error`, `stats` (`bitrateKbps`, `speed`) |
| `GET /api/storage` | `freeBytes`, `usedBytes`, `quotaBytes`, `maxUploadBytes` |
| `POST /api/uploads` `{filename, size, title?}` | Start an upload → `{id, chunkSize}` |
| `PUT /api/uploads/:id?offset=N` (raw bytes, `Content-Length` ≤ 32 MB) | Send a chunk. `409` + `{received}` means "continue from `received`" |
| `GET /api/uploads/:id` | `{received, size, status}` for resuming |
| `POST /api/uploads/:id/complete` | Finish; the server checks the file (and converts only if needed) |
| `GET /api/videos` | Videos with `status`: `uploading`/`processing`/`ready`/`failed` |
| `DELETE /api/videos/:id` | Delete (not while scheduled or processing) |
| `POST /api/schedules` `{video_ids[], start_at (epoch ms), loop_count?, dest_ids?, delete_after?, title?}` | Schedule a live. `loop_count` 1-50, `0` = until cancelled. Playlist videos must share size and frame rate |
| `GET /api/schedules` | List with `status`: `scheduled`/`running`/`done`/`failed`/`missed`/`cancelled` |
| `POST /api/schedules/:id/cancel` | Cancel, or stop a running live |
| `GET /api/recordings` | Recorded OBS lives |
| `GET /api/recordings/:id/download` | Download (supports `Range`) |
| `POST /api/recordings/:id/to-video` | Turn a recording into a schedulable video |
| `DELETE /api/recordings/:id` | Delete |

Errors are JSON: `{ "error": "message" }` with a normal HTTP status.

## curl examples

```bash
KEY=vs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $KEY" https://live.vividbrandify.com/api/status
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"video_ids":[12],"start_at":1795000000000,"loop_count":1}' \
  https://live.vividbrandify.com/api/schedules
```
