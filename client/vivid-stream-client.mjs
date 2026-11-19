// Small zero-dependency client for Vivid Stream (Node 18+). Use it from Vividora or any script.
//
//   import { VividStream } from './vivid-stream-client.mjs';
//   const vs = new VividStream({ baseUrl: 'https://live.vividbrandify.com', apiKey: 'vs_...' });
//   const video = await vs.uploadVideo('/path/final.mp4', { title: 'Morning bulletin' });
//   await vs.scheduleLive({ videoIds: [video.id], startAt: new Date('2026-11-20T18:30:00+05:30') });
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class VividStreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class VividStream {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
    if (!baseUrl || !apiKey) throw new Error('baseUrl and apiKey are required');
    this.base = baseUrl.replace(/\/+$/, '');
    this.key = apiKey;
    this.fetch = fetchImpl;
  }

  async request(method, url, { json, raw, allow409 = false } = {}) {
    const headers = { authorization: `Bearer ${this.key}` };
    let body;
    if (raw) { headers['content-type'] = 'application/octet-stream'; body = raw; }
    else if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await this.fetch(this.base + url, { method, headers, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(allow409 && res.status === 409)) throw new VividStreamError(data.error || `HTTP ${res.status}`, res.status);
    return { status: res.status, data };
  }

  async status() { return (await this.request('GET', '/api/status')).data; }
  async destinations() { return (await this.status()).destinations; }
  async videos() { return (await this.request('GET', '/api/videos')).data.videos; }
  async schedules() { return (await this.request('GET', '/api/schedules')).data.schedules; }

  /**
   * Uploads a file in chunks (resumes after network errors), then waits until the server has
   * checked/prepared it. Returns the video record (status "ready").
   */
  async uploadVideo(filePath, { title, onProgress, waitReady = true, pollMs = 3000, timeoutMs = 2 * 3600 * 1000 } = {}) {
    const stat = await fs.stat(filePath);
    const { data: created } = await this.request('POST', '/api/uploads', {
      json: { filename: path.basename(filePath), size: stat.size, title },
    });
    const { id, chunkSize } = created;
    const fh = await fs.open(filePath, 'r');
    try {
      let offset = 0;
      let failures = 0;
      while (offset < stat.size) {
        const len = Math.min(chunkSize, stat.size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        try {
          const r = await this.request('PUT', `/api/uploads/${id}?offset=${offset}`, { raw: buf, allow409: true });
          offset = r.data.received; // on 409 the server tells us where it really is
          failures = 0;
        } catch (e) {
          if (e instanceof VividStreamError && e.status < 500) throw e;
          if ((failures += 1) > 8) throw e;
          await sleep(Math.min(2000 * failures, 15000));
          offset = (await this.request('GET', `/api/uploads/${id}`)).data.received;
        }
        onProgress?.(offset / stat.size);
      }
    } finally {
      await fh.close();
    }
    await this.request('POST', `/api/uploads/${id}/complete`);
    if (!waitReady) return { id, status: 'processing' };

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = (await this.videos()).find((x) => x.id === id);
      if (v?.status === 'ready') return v;
      if (!v || v.status === 'failed') throw new VividStreamError(v?.error || 'Video processing failed', 422);
      if (Date.now() > deadline) throw new VividStreamError('Timed out while the server prepared the video', 408);
      await sleep(pollMs);
    }
  }

  /** startAt: Date or epoch milliseconds. loops: 1..50, or 0 to repeat until cancelled. */
  async scheduleLive({ videoIds, startAt, loops = 1, destIds, deleteAfter = true, title }) {
    const { data } = await this.request('POST', '/api/schedules', {
      json: {
        video_ids: videoIds, start_at: startAt instanceof Date ? startAt.getTime() : startAt,
        loop_count: loops, dest_ids: destIds, delete_after: deleteAfter, title,
      },
    });
    return data.schedule;
  }

  async cancelSchedule(id) { await this.request('POST', `/api/schedules/${id}/cancel`); }
  async deleteVideo(id) { await this.request('DELETE', `/api/videos/${id}`); }
}
