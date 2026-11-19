import { spawn as nodeSpawn } from 'node:child_process';

// ffmpeg arguments for one destination. "-c copy" means no re-encoding,
// so CPU use stays close to zero; resolution/bitrate are whatever OBS sends.
export function buildArgs({ input, output }) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-nostats', '-progress', 'pipe:1',
    '-i', input,
    '-c', 'copy',
    '-f', 'flv', '-flvflags', 'no_duration_filesize',
    output,
  ];
}

export function joinUrl(base, key) {
  return `${base.replace(/\/+$/, '')}/${key}`;
}

export function maskSecrets(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

/**
 * Watches MediaMTX for live ingest paths ("live/<ingestKey>") and keeps one
 * ffmpeg process running per enabled destination of the owning user.
 * - OBS connects  -> relays start (within one poll interval)
 * - OBS drops     -> relays stop
 * - ffmpeg dies   -> restarted with exponential backoff, other destinations unaffected
 */
export class RelayManager {
  constructor({
    store, vault, cfg, internalToken,
    spawn = nodeSpawn, fetchImpl = globalThis.fetch, log = console, onEvent = () => {},
  }) {
    this.store = store;
    this.vault = vault;
    this.cfg = cfg;
    this.internalToken = internalToken;
    this.spawn = spawn;
    this.fetch = fetchImpl;
    this.log = log;
    this.onEvent = onEvent;
    this.relays = new Map(); // destId -> entry
    this.liveKeys = new Set();
    this.filters = new Map(); // ingestKey -> Set<destId> (set while a scheduled video plays)
    this.expectedDrops = new Set(); // keys whose stream is about to end on purpose (scheduled video finished)
    this.apiOk = null;
    this.timer = null;
    this.ticking = false;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('tick failed', e)), this.cfg.pollMs);
    this.tick().catch((e) => this.log.error('tick failed', e));
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const id of [...this.relays.keys()]) this.stop(id, 'shutdown', true);
  }

  async fetchLiveKeys() {
    const res = await this.fetch(`${this.cfg.mediamtxApi}/v3/paths/list?itemsPerPage=1000`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
    const body = await res.json();
    const keys = new Set();
    for (const item of body.items || []) {
      if (item.ready && typeof item.name === 'string' && item.name.startsWith('live/')) {
        keys.add(item.name.slice(5));
      }
    }
    return keys;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let live;
      try {
        live = await this.fetchLiveKeys();
        this.apiOk = true;
      } catch (e) {
        // If MediaMTX is unreachable we do not know the state: leave relays alone.
        if (this.apiOk !== false) this.log.warn?.(`MediaMTX API unreachable: ${e.message}`);
        this.apiOk = false;
        return;
      }
      const prev = this.liveKeys;
      this.liveKeys = live;
      this.detectIngestChanges(prev, live);

      const wanted = new Map(); // destId -> { dest, key }
      for (const key of live) {
        const user = this.store.getUserByIngestKey(key);
        if (!user || !user.active) continue;
        // A scheduled video may restrict the live to specific destinations.
        const only = this.filters.get(key);
        for (const dest of this.store.listEnabledDestinations(user.id)) {
          if (!only || only.has(dest.id)) wanted.set(dest.id, { dest, key });
        }
      }

      for (const [id, entry] of [...this.relays]) {
        const w = wanted.get(id);
        if (!w || w.key !== entry.key || entry.sig !== sigOf(w.dest)) {
          this.stop(id, w ? 'changed' : 'stopped');
        }
      }
      for (const [id, w] of wanted) {
        if (!this.relays.has(id)) this.begin(w.dest, w.key);
      }
    } finally {
      this.ticking = false;
    }
  }

  begin(dest, key) {
    const entry = {
      destId: dest.id, userId: dest.user_id, name: dest.name, key, sig: sigOf(dest),
      status: 'starting', since: Date.now(), restarts: 0, lastError: null,
      proc: null, timer: null, stableTimer: null, killTimer: null,
      backoff: this.cfg.backoffBaseMs, stopping: false, startedAt: 0,
    };
    this.relays.set(dest.id, entry);
    this.run(entry, dest);
  }

  run(entry, dest) {
    let streamKey;
    try {
      streamKey = this.vault.decrypt(dest.key_enc);
    } catch {
      this.setStatus(entry, 'error', 'Stored stream key cannot be decrypted (APP_SECRET changed?)');
      return;
    }
    const input = `${this.cfg.mediamtxRtmp}/live/${entry.key}?token=${this.internalToken}`;
    const output = joinUrl(dest.rtmp_url, streamKey);
    const secrets = [streamKey, this.internalToken];
    const args = buildArgs({ input, output });

    entry.stats = { bitrateKbps: null, speed: null, at: 0 };
    entry.history = [];
    entry.lastSample = 0;
    entry.slowSince = 0;
    entry.slowReported = false;
    let proc;
    try {
      proc = this.spawn(this.cfg.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.setStatus(entry, 'error', `Cannot start ffmpeg: ${e.message}`);
      this.scheduleRestart(entry, dest);
      return;
    }
    entry.proc = proc;
    entry.startedAt = Date.now();
    this.setStatus(entry, 'starting', null);

    // ffmpeg -progress writes "key=value" lines; a block ends with "progress=continue".
    let buf = '';
    proc.stdout?.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq); const v = line.slice(eq + 1);
        if (k === 'bitrate' && v !== 'N/A') entry.stats.bitrateKbps = parseFloat(v) || 0;
        else if (k === 'speed' && v !== 'N/A') entry.stats.speed = parseFloat(v) || 0;
        else if (k === 'progress') {
          entry.stats.at = Date.now(); this.checkSlow(entry);
          if (entry.stats.at - entry.lastSample >= 5000 && entry.stats.bitrateKbps !== null) { // one point per 5 s, last 5 minutes
            entry.lastSample = entry.stats.at;
            entry.history.push(Math.round(entry.stats.bitrateKbps));
            if (entry.history.length > 60) entry.history.shift();
          }
        }
      }
    });

    let lastLine = '';
    proc.stderr?.on('data', (chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      if (lines.length) lastLine = maskSecrets(lines[lines.length - 1], secrets).slice(0, 300);
    });

    entry.stableTimer = setTimeout(() => {
      if (entry.proc === proc && !entry.stopping) this.setStatus(entry, 'live', null);
    }, this.cfg.stableMs);

    proc.on('error', (e) => {
      lastLine = e.code === 'ENOENT' ? 'ffmpeg not found on the server' : e.message;
    });
    proc.on('close', (code, signal) => {
      clearTimeout(entry.stableTimer);
      entry.proc = null;
      if (entry.stopping) return;
      const ranMs = Date.now() - entry.startedAt;
      if (ranMs > 60000) entry.backoff = this.cfg.backoffBaseMs;
      this.setStatus(entry, 'error', lastLine || `ffmpeg exited (${signal || code})`);
      this.scheduleRestart(entry, dest);
    });
  }

  scheduleRestart(entry, dest) {
    if (entry.stopping) return;
    entry.restarts += 1;
    const delay = entry.backoff;
    entry.backoff = Math.min(entry.backoff * 2, this.cfg.backoffMaxMs);
    entry.timer = setTimeout(() => {
      if (entry.stopping || this.relays.get(entry.destId) !== entry) return;
      this.run(entry, dest);
    }, delay);
  }

  /** If the destination cannot keep up (speed stays well below 1x) the viewers will see buffering. */
  checkSlow(entry) {
    const speed = entry.stats.speed;
    if (speed === null || entry.status !== 'live') return;
    if (speed >= 0.85) { entry.slowSince = 0; entry.slowReported = false; return; }
    if (!entry.slowSince) { entry.slowSince = Date.now(); return; }
    if (!entry.slowReported && Date.now() - entry.slowSince > (this.cfg.slowMs ?? 20000)) {
      entry.slowReported = true;
      this.onEvent({ type: 'slow', destId: entry.destId, userId: entry.userId, name: entry.name, detail: `${speed.toFixed(2)}x` });
    }
  }

  setStatus(entry, status, error) {
    const changed = entry.status !== status || (error && entry.lastError !== error);
    entry.status = status;
    if (error !== undefined && error !== null) entry.lastError = error;
    if (status === 'live') entry.lastError = null;
    if (changed && (status === 'live' || status === 'error')) {
      this.onEvent({ type: status, destId: entry.destId, userId: entry.userId, name: entry.name, detail: error || '' });
    }
  }

  stop(destId, reason = 'stopped', immediate = false) {
    const entry = this.relays.get(destId);
    if (!entry) return;
    entry.stopping = true;
    clearTimeout(entry.timer);
    clearTimeout(entry.stableTimer);
    this.relays.delete(destId);
    const proc = entry.proc;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      if (!immediate) {
        entry.killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
        entry.killTimer.unref?.();
      } else {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
      }
    }
    if (entry.status === 'live' || entry.status === 'starting') {
      this.onEvent({ type: 'stopped', destId, userId: entry.userId, name: entry.name, detail: reason });
    }
  }

  detectIngestChanges(prev, live) {
    for (const key of live) {
      if (prev.has(key) || this.filters.has(key)) continue; // already known, or a scheduled video (has its own alert)
      const user = this.store.getUserByIngestKey(key);
      if (user?.active) {
        this.onEvent({ type: 'ingest_started', userId: user.id, name: user.name, detail: String(this.store.listEnabledDestinations(user.id).length) });
      }
    }
    for (const key of prev) {
      if (live.has(key)) continue;
      if (this.expectedDrops.delete(key) || this.filters.has(key)) continue;
      const user = this.store.getUserByIngestKey(key);
      if (user?.active) this.onEvent({ type: 'ingest_dropped', userId: user.id, name: user.name, detail: '' });
    }
  }

  /** Called by the scheduler right before a scheduled video ends, so that is not reported as a dropped stream. */
  noteExpectedDrop(ingestKey) {
    this.expectedDrops.add(ingestKey);
    setTimeout(() => this.expectedDrops.delete(ingestKey), 30000).unref?.();
  }

  /** Restrict (Set of destination ids) or un-restrict (null) the relays for one ingest key. */
  setFilter(ingestKey, destIds) {
    if (destIds) this.filters.set(ingestKey, new Set(destIds));
    else this.filters.delete(ingestKey);
  }

  isIngestLive(ingestKey) {
    return this.liveKeys.has(ingestKey);
  }

  statusFor(destId) {
    const e = this.relays.get(destId);
    if (!e) return { status: 'idle', error: null, since: null, restarts: 0, stats: null, history: [] };
    const fresh = e.stats && Date.now() - e.stats.at < 15000;
    return {
      status: e.status, error: e.lastError, since: e.since, restarts: e.restarts,
      stats: fresh ? { bitrateKbps: e.stats.bitrateKbps, speed: e.stats.speed } : null,
      history: fresh ? [...(e.history || [])] : [],
    };
  }
}

function sigOf(dest) {
  return `${dest.rtmp_url}|${dest.key_enc}`;
}
