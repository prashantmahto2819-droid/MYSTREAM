import { execFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';

export const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v', 'ts', 'flv', 'avi']);
const MAX_KEYFRAME_GAP = 4.1; // YouTube/Facebook want a keyframe at least every ~4s (2s recommended)

const run = (bin, args, { timeout = 120000 } = {}) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').pop()));
    else resolve(stdout.toString());
  });
});

const parseRate = (r) => {
  const [a, b] = String(r || '0/1').split('/').map(Number);
  return b ? a / b : a || 0;
};

/** Reads codecs, size, fps, duration and the largest keyframe gap of the first two minutes. */
export async function probeVideo(ffprobeBin, file) {
  const meta = JSON.parse(await run(ffprobeBin, [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration',
    '-of', 'json', file,
  ]));
  const v = (meta.streams || []).find((s) => s.codec_type === 'video');
  const a = (meta.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video track found in this file');

  let maxKeyGap = 0;
  try {
    const out = await run(ffprobeBin, [
      '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-read_intervals', '%+120', '-of', 'csv=p=0', file,
    ], { timeout: 180000 });
    const t = out.split('\n').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
    for (let i = 1; i < t.length; i += 1) maxKeyGap = Math.max(maxKeyGap, t[i] - t[i - 1]);
    if (t.length < 2 && Number(meta.format?.duration) > 8) maxKeyGap = 999;
  } catch { maxKeyGap = 999; }

  return {
    vcodec: v.codec_name, acodec: a?.codec_name || null, pixFmt: v.pix_fmt,
    width: v.width, height: v.height, fps: Math.round(parseRate(v.avg_frame_rate) * 100) / 100,
    duration: Number(meta.format?.duration) || 0, maxKeyGap,
  };
}

/** Copy mode only works if the file is already stream-friendly; otherwise re-encode once at upload. */
export function needsConvert(info) {
  return info.vcodec !== 'h264' || info.pixFmt !== 'yuv420p' ||
    info.acodec !== 'aac' || info.maxKeyGap > MAX_KEYFRAME_GAP;
}

export function convertArgs(input, output, hasAudio, fps = 0) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(fps ? ['-r', String(fps)] : []), // browser recordings have a variable frame rate
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  if (!hasAudio) args.push('-shortest');
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/**
 * After the upload finishes: probe the file, re-encode only if needed
 * (one at a time, so the server stays responsive), then mark it ready.
 */
export class VideoProcessor {
  constructor({ store, cfg, spawn = nodeSpawn, probe = probeVideo, log = console, onDone = () => {} }) {
    Object.assign(this, { store, cfg, spawn, probe, log, onDone });
    this.queue = [];
    this.working = false;
    this.current = null;
    this.stopped = false;
  }

  enqueue(videoId) {
    this.queue.push(videoId);
    this.pump();
  }

  async pump() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      while (this.queue.length && !this.stopped) await this.process(this.queue.shift());
    } finally {
      this.working = false;
    }
  }

  async process(id) {
    const v = this.store.getVideo(id);
    if (!v || v.status !== 'processing') return;
    try {
      let info = await this.probe(this.cfg.ffprobeBin, v.file_path);
      if (needsConvert(info)) {
        const out = `${v.file_path}.conv.mp4`;
        await this.convert(v.file_path, out, !!info.acodec, ['vp8', 'vp9'].includes(info.vcodec) ? 30 : 0);
        const final = v.file_path.replace(/\.[^.]+$/, '') + '.mp4';
        fs.renameSync(out, final);
        if (final !== v.file_path) fs.rmSync(v.file_path, { force: true });
        this.store.updateVideo(id, { filePath: final, ext: 'mp4', size: fs.statSync(final).size });
        info = await this.probe(this.cfg.ffprobeBin, final);
      }
      this.store.updateVideo(id, {
        status: 'ready', error: null, duration: info.duration, width: info.width, height: info.height, fps: info.fps,
      });
      this.onDone(this.store.getVideo(id));
    } catch (e) {
      this.log.error?.(`video ${id} processing failed: ${e.message}`);
      this.store.updateVideo(id, { status: 'failed', error: String(e.message).slice(0, 300) });
      this.onDone(this.store.getVideo(id));
    }
  }

  convert(input, output, hasAudio, fps = 0) {
    return new Promise((resolve, reject) => {
      const p = this.spawn(this.cfg.ffmpegBin, convertArgs(input, output, hasAudio, fps), { stdio: ['ignore', 'ignore', 'pipe'] });
      this.current = p;
      let err = '';
      p.stderr?.on('data', (c) => { err = (err + c).slice(-500); });
      p.on('error', (e) => reject(e));
      p.on('close', (code) => {
        this.current = null;
        if (code === 0) resolve();
        else {
          fs.rmSync(output, { force: true });
          reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
        }
      });
    });
  }

  shutdown() {
    this.stopped = true;
    try { this.current?.kill('SIGKILL'); } catch { /* gone */ }
  }

  /** After a restart, files that were still being processed are queued again. */
  resume() {
    for (const v of this.store.listVideos(null)) {
      if (v.status === 'processing') this.enqueue(v.id);
    }
  }
}
