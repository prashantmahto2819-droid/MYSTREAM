import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function buildPlayArgs({ listFile, output, infinite }) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-re',
    ...(infinite ? ['-stream_loop', '-1'] : []),
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    '-f', 'flv', '-flvflags', 'no_duration_filesize',
    output,
  ];
}

/** concat-demuxer list: one "file" line per play. Paths are server-generated (never user text). */
export function buildConcatList(files, loops) {
  const lines = [];
  const n = loops === 0 ? 1 : loops;
  for (let i = 0; i < n; i += 1) for (const f of files) lines.push(`file '${f.replace(/'/g, "'\\''")}'`);
  return lines.join('\n') + '\n';
}

/**
 * Starts scheduled videos on time. A schedule plays through ONE ffmpeg process (concat, copy mode)
 * that publishes into MediaMTX as if it were OBS - so the normal relay fans it out to every
 * destination and the connection to YouTube/Facebook is never interrupted between playlist items.
 */
export class SchedulePlayer {
  constructor({
    store, cfg, relay, notifier, spawn = nodeSpawn, now = Date.now, log = console, dataDir, onEvent = () => {},
  }) {
    Object.assign(this, { store, cfg, relay, notifier, spawn, now, log, dataDir, onEvent });
    this.running = new Map(); // scheduleId -> { proc, cancelled, listFile }
    this.timer = null;
  }

  start() {
    // A restart while live means that live was cut off.
    for (const s of this.store.listAllActiveSchedules()) {
      if (s.status === 'running') this.finish(s, 'failed', 'Server restarted while live', false);
    }
    this.timer = setInterval(() => this.tick(), this.cfg.schedulePollMs);
    this.tick();
  }

  tick() {
    const now = this.now();
    for (const s of this.store.listDueSchedules(now)) {
      if (this.running.has(s.id)) continue;
      if (now - s.start_at > this.cfg.lateStartMs) {
        this.finish(s, 'missed', 'Server was not ready at the scheduled time', false);
      } else {
        this.play(s);
      }
    }
  }

  play(s) {
    const user = this.store.getUser(s.user_id);
    const videos = s.video_ids.map((id) => this.store.getVideo(id));
    const bad = !user || !user.active ? 'User is disabled'
      : videos.some((v) => !v || v.status !== 'ready' || !fs.existsSync(v.file_path)) ? 'A video is missing or not ready'
        : this.relay.isIngestLive(user.ingest_key) ? 'You are already live from OBS on this stream key'
          : null;
    if (bad) return this.finish(s, 'failed', bad, true);

    // Which destinations: those picked for this schedule, or all enabled ones.
    const enabled = this.store.listEnabledDestinations(user.id).map((d) => d.id);
    const picked = s.dest_ids ? enabled.filter((id) => s.dest_ids.includes(id)) : enabled;
    if (!picked.length) return this.finish(s, 'failed', 'No enabled destination to send to', true);

    const listDir = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(listDir, { recursive: true });
    const listFile = path.join(listDir, `schedule-${s.id}.txt`);
    fs.writeFileSync(listFile, buildConcatList(videos.map((v) => v.file_path), s.loop_count));

    const output = `${this.cfg.mediamtxRtmp}/live/${user.ingest_key}`;
    const args = buildPlayArgs({ listFile, output, infinite: s.loop_count === 0 });
    const state = { proc: null, cancelled: false, listFile, lastLine: '' };
    this.running.set(s.id, state);
    this.relay.setFilter(user.ingest_key, picked);
    this.store.updateSchedule(s.id, { status: 'running', startedAt: this.now(), error: null });
    this.onEvent({ type: 'started', schedule: s, userId: s.user_id, destinations: picked.length });

    let proc;
    try {
      proc = this.spawn(this.cfg.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return this.end(s, user, state, 'failed', `Cannot start ffmpeg: ${e.message}`);
    }
    state.proc = proc;
    proc.stderr?.on('data', (c) => {
      const lines = String(c).split(/\r?\n/).filter(Boolean);
      if (lines.length) state.lastLine = lines[lines.length - 1].slice(0, 300);
    });
    proc.on('error', (e) => { state.lastLine = e.code === 'ENOENT' ? 'ffmpeg not found on the server' : e.message; });
    proc.on('close', (code, signal) => {
      if (this.stopping) return;
      if (state.cancelled) return this.end(s, user, state, 'cancelled', null);
      if (code === 0) return this.end(s, user, state, 'done', null);
      return this.end(s, user, state, 'failed', state.lastLine || `ffmpeg exited (${signal || code})`);
    });
  }

  end(s, user, state, status, error) {
    this.running.delete(s.id);
    this.relay.setFilter(user.ingest_key, null);
    fs.rmSync(state.listFile, { force: true });
    this.finish(s, status, error, true);
  }

  finish(s, status, error, wasStarted) {
    this.store.updateSchedule(s.id, { status, error, endedAt: this.now() });
    if (status === 'done' && s.delete_after) this.cleanupVideos(s);
    this.onEvent({ type: status, schedule: { ...s, status, error }, userId: s.user_id, wasStarted });
  }

  /** Removes files used by this schedule unless another upcoming schedule still needs them. */
  cleanupVideos(s) {
    for (const id of s.video_ids) {
      const v = this.store.getVideo(id);
      if (!v || this.store.videoInUse(id)) continue;
      fs.rmSync(v.file_path, { force: true });
      this.store.deleteVideo(id);
      this.onEvent({ type: 'video_deleted', schedule: s, userId: s.user_id, video: v });
    }
  }

  cancel(scheduleId) {
    const st = this.running.get(scheduleId);
    if (st) {
      st.cancelled = true;
      try { st.proc?.kill('SIGTERM'); } catch { /* gone */ }
      return true;
    }
    const s = this.store.getSchedule(scheduleId);
    if (s && s.status === 'scheduled') {
      this.store.updateSchedule(s.id, { status: 'cancelled', endedAt: this.now() });
      return true;
    }
    return false;
  }

  shutdown() {
    // Leave the schedule marked "running": on the next start it is reported as cut off by the restart.
    clearInterval(this.timer);
    this.stopping = true;
    for (const [id, st] of this.running) {
      try { st.proc?.kill('SIGKILL'); } catch { /* gone */ }
      this.running.delete(id);
    }
  }
}
