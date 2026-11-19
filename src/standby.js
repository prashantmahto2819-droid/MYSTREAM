import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

const FONTS = ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];

/** A calm "we will be back" picture + silence, published as if it were OBS. */
export function buildStandbyArgs({ output, textFile, fontFile, maxSeconds }) {
  const vf = textFile && fontFile
    ? `drawtext=fontfile=${fontFile}:textfile=${textFile}:fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2`
    : 'null';
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-re', '-f', 'lavfi', '-i', 'color=c=0x1d2b64:s=1280x720:r=30',
    '-re', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', vf, '-t', String(maxSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60', '-b:v', '1200k',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'flv', '-flvflags', 'no_duration_filesize', output,
  ];
}

/**
 * When OBS drops, keeps the destinations connected for a few minutes by publishing a standby
 * slate on the same key. When OBS reconnects it takes over the key and the slate ends by itself.
 * Off by default: a stream that is ended on purpose looks the same as a dropped one.
 */
export class Standby {
  constructor({ store, relay, cfg, dataDir, spawn = nodeSpawn, onEvent = () => {}, log = console }) {
    Object.assign(this, { store, relay, cfg, dataDir, spawn, onEvent, log });
    this.running = new Map(); // userId -> { proc, timer, intentional, since, lastLine, textFile }
  }

  handle(ev) {
    if (ev.type === 'ingest_dropped') this.start(ev.userId);
  }

  isActive(userId) { return this.running.has(userId); }
  since(userId) { return this.running.get(userId)?.since || null; }

  start(userId) {
    const user = this.store.getUser(userId);
    if (!user || !user.active || !user.standby || this.running.has(userId)) return false;
    const dests = this.store.listEnabledDestinations(userId).map((d) => d.id);
    if (!dests.length) return false;
    const minutes = Math.min(Math.max(Number(user.standby_minutes) || 10, 1), 60);
    const st = { proc: null, timer: null, intentional: false, since: Date.now(), lastLine: '', textFile: null };

    let textFile = null; let fontFile = null;
    try {
      fontFile = FONTS.find((f) => fs.existsSync(f)) || null;
      if (fontFile) {
        const dir = path.join(this.dataDir, 'tmp'); fs.mkdirSync(dir, { recursive: true });
        textFile = path.join(dir, `standby-${userId}.txt`);
        fs.writeFileSync(textFile, user.standby_text || 'We will be back shortly');
        st.textFile = textFile;
      }
    } catch { textFile = null; }

    const args = buildStandbyArgs({ output: `${this.cfg.mediamtxRtmp}/live/${user.ingest_key}`, textFile, fontFile, maxSeconds: minutes * 60 });
    this.relay.setFilter(user.ingest_key, dests); // our own slate is not "OBS started"
    let proc;
    try { proc = this.spawn(this.cfg.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
      this.relay.setFilter(user.ingest_key, null);
      this.onEvent({ type: 'standby_failed', userId, detail: e.message });
      return false;
    }
    st.proc = proc; this.running.set(userId, st);
    proc.stderr?.on('data', (c) => { const l = String(c).split(/\r?\n/).filter(Boolean); if (l.length) st.lastLine = l[l.length - 1].slice(0, 200); });
    proc.on('error', (e) => { st.lastLine = e.message; });
    proc.on('close', (code) => this.ended(userId, user, st, code));
    st.timer = setTimeout(() => this.stop(userId, true), minutes * 60000);
    st.timer.unref?.();
    this.onEvent({ type: 'standby_started', userId, name: user.name, detail: String(minutes) });
    return true;
  }

  ended(userId, user, st, code) {
    if (this.running.get(userId) !== st) return;
    this.running.delete(userId);
    clearTimeout(st.timer);
    if (st.textFile) fs.rmSync(st.textFile, { force: true });
    if (st.intentional || st.timedOut) this.relay.noteExpectedDrop?.(user.ingest_key);
    this.relay.setFilter(user.ingest_key, null);
    if (st.timedOut) return this.onEvent({ type: 'standby_timeout', userId, name: user.name });
    if (st.intentional) return this.onEvent({ type: 'standby_stopped', userId, name: user.name });
    // Not stopped by us: OBS took the key over (normal) or ffmpeg failed.
    if (code === 0 || this.relay.isIngestLive(user.ingest_key)) return this.onEvent({ type: 'standby_ended', userId, name: user.name });
    return this.onEvent({ type: 'standby_failed', userId, name: user.name, detail: st.lastLine || `ffmpeg exited (${code})` });
  }

  stop(userId, timedOut = false) {
    const st = this.running.get(userId);
    if (!st) return false;
    if (timedOut) st.timedOut = true; else st.intentional = true;
    try { st.proc.kill('SIGTERM'); } catch { /* ignore */ }
    return true;
  }

  shutdown() {
    for (const [id, st] of this.running) { st.intentional = true; clearTimeout(st.timer); try { st.proc.kill('SIGTERM'); } catch { /* ignore */ } this.running.delete(id); }
  }
}
