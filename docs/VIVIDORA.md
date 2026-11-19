# Connecting Vividora (or any program)

Vivid Stream has an HTTP API with API keys (see `API.md`). Vividora needs three things:
a base URL, an API key, and the rendered video file.

## 1. Make an API key
Dashboard -> **Settings** -> **Create API key** -> name it `Vividora` -> copy it once (`vs_...`).
Keep it in Vividora's secret storage, never in code or in the browser.

## 2. In Vividora's server code (Node 18+)
Copy `client/vivid-stream-client.mjs` into Vividora (single file, no dependencies) and:

```js
import { VividStream } from './vivid-stream-client.mjs';

const vs = new VividStream({ baseUrl: process.env.VIVID_STREAM_URL, apiKey: process.env.VIVID_STREAM_KEY });

// "Schedule Live" button handler: file = the rendered video on Vividora's disk
export async function scheduleLive({ file, title, startAtIso, destinationNames }) {
  const dests = await vs.destinations();
  const ids = dests.filter((d) => !destinationNames || destinationNames.includes(d.name)).map((d) => d.id);
  const video = await vs.uploadVideo(file, { title });          // resumable, waits until ready
  return vs.scheduleLive({ videoIds: [video.id], startAt: new Date(startAtIso), destIds: ids });
}
```

Environment: `VIVID_STREAM_URL=https://live.vividbrandify.com`, `VIVID_STREAM_KEY=vs_...`.

## 3. The button in Vividora
1. The button calls Vividora's own backend route (never Vivid Stream directly from the browser).
2. That route calls `scheduleLive(...)` above and returns the schedule id and time.
3. Show the status with `vs.schedules()` (scheduled / running / done / failed).
4. After the live, Vivid Stream deletes the video by itself.

## Notes
- Times are absolute (ISO or milliseconds); the dashboard shows them in IST.
- A video must be H.264/AAC; anything else is converted after upload (status `processing`).
- If the same time is already taken, the API answers 409.
