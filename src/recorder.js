import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function buildRecordArgs({ input, output, maxSeconds }) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-i', input, '-c', 'copy', '-t', String(maxSeconds),
    '-f', 'matroska', output,
  ];
}

/**
 * Saves a copy of a live (copy mode, Matroska so a crash does not corrupt the file) for users who
 * switched "Record my lives" on. Old recordings are removed by housekeeping after RECORDING_KEEP_DAYS.
 */
export class Recorder {
  constructor({ store, cfg, relay, internalToken, spawn = nodeSpawn, log = console, now = Date.now, onEvent = () => {}, freeBytes }) {
    Object.assign(this, { store, cfg, relay, internalToken, spawn, log, now, onEvent });
    this.freeBytes = freeBytes || (() => { const s = fs.statfsSync(cfg.dataDir); return Number(s.bavail) * Number(s.bsize); });
    this.running = new Map(); // userId -> { proc, key, recId, file, stopping }
    this.cooldown = new Map(); // userId -> earliest next start
    this.timer = null;
  }

  start() {
    // Recordings that were open when the server stopped are finalised with whatever was written.
    for (const r of this.store.listOpenRecordings()) this.finalize(r.id, r.file_path);
    this.timer = setInterval(() => this.tick(), 3000);
    this.tick();
  }

  tick() {
    const live = this.relay.liveKeys;
    for (const key of live) {
      const user = this.store.getUserByIngestKey(key);
      if (!user || !user.active || !user.record) continue;
      if (this.relay.filters.has(key)) continue; // a scheduled video is playing: we already have that file
      if (this.running.has(user.id) || (this.cooldown.get(user.id) || 0) > this.now()) continue;
      this.begin(user, key);
    }
    for (const [uid, rec] of this.running) {
      const user = this.store.getUser(uid);
      if (!live.has(rec.key) || !user || !user.record || this.relay.filters.has(rec.key)) this.stop(uid);
    }
  }

  begin(user, key) {
    if (this.freeBytes() - this.cfg.diskReserveBytes < 1024 ** 3) {
      this.cooldown.set(user.id, this.now() + 10 * 60000);
      this.onEvent({ type: 'record_skipped', userId: user.id, detail: 'Not enough free disk space' });
      return;
    }
    const dir = path.join(this.cfg.dataDir, 'recordings', String(user.id));
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = this.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}.mkv`);
    const title = `Live ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const recId = this.store.createRecording({ userId: user.id, title, filePath: file, startedAt });
    const input = `${this.cfg.mediamtxRtmp}/live/${key}?token=${this.internalToken}`;
    let proc;
    try {
      proc = this.spawn(this.cfg.ffmpegBin, buildRecordArgs({ input, output: file, maxSeconds: this.cfg.recordingMaxHours * 3600 }), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this.store.deleteRecording(recId);
      this.cooldown.set(user.id, this.now() + 30000);
      this.log.error?.(`recorder cannot start: ${e.message}`);
      return;
    }
    const rec = { proc, key, recId, file, stopping: false };
    this.running.set(user.id, rec);
    proc.stderr?.on('data', () => {});
    proc.on('error', () => {});
    proc.on('close', () => {
      this.running.delete(user.id);
      this.cooldown.set(user.id, this.now() + 15000);
      this.finalize(recId, file);
    });
    this.onEvent({ type: 'record_started', userId: user.id, detail: title });
  }

  finalize(recId, file) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size < 1024 * 1024) { // an accidental few-second blip is not worth keeping
      fs.rmSync(file, { force: true });
      this.store.deleteRecording(recId);
      return;
    }
    this.store.updateRecording(recId, { size, status: 'done', endedAt: this.now() });
    const r = this.store.getRecording(recId);
    this.onEvent({ type: 'record_saved', userId: r.user_id, detail: `${r.title} (${(size / 1024 ** 2).toFixed(0)} MB)` });
  }

  stop(userId) {
    const rec = this.running.get(userId);
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    try { rec.proc.kill('SIGINT'); } catch { /* gone */ }
    const t = setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    t.unref?.();
  }

  shutdown() {
    clearInterval(this.timer);
    for (const uid of [...this.running.keys()]) this.stop(uid);
  }

  /** Housekeeping: remove recordings older than the retention period. */
  purgeOld() {
    const cutoff = this.now() - this.cfg.recordingKeepDays * 24 * 3600 * 1000;
    for (const r of this.store.listOldRecordings(cutoff)) {
      fs.rmSync(r.file_path, { force: true });
      this.store.deleteRecording(r.id);
    }
  }
}
