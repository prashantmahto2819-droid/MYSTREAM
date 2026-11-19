import { spawn as nodeSpawn } from 'node:child_process';
import { acceptKey, encodeText, encodeClose, encodeFrame, FrameParser } from './ws.js';

/**
 * ffmpeg reads the browser's WebM (MediaRecorder) from stdin and publishes H.264/AAC into
 * MediaMTX exactly like OBS would, so the normal relay fans it out to every destination.
 * The video is re-encoded (browser keyframes are unpredictable; YouTube wants <= 4s) but
 * at veryfast/720p30 that is roughly one CPU core.
 */
export function buildStudioArgs({ output, hasAudio = true, height = 720, fps = 30, kbps = 3000 }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0'];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  args.push(
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0?' : '1:a:0',
    '-vf', `scale=-2:${height}`, '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.15)}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-af', 'aresample=async=1:first_pts=0',
    ...(hasAudio ? [] : ['-shortest']), // the silent source is endless; stop when the video stops
    '-f', 'flv', '-flvflags', 'no_duration_filesize', output,
  );
  return args;
}

const QUALITY = { 480: 1500, 720: 3000, 1080: 5000 };

export function attachStudio(server, { store, relay, cfg, spawn = nodeSpawn, parseCookies, log = console, onEvent = () => {}, maxBuffered = 24 * 1024 * 1024 }) {
  const active = new Map(); // userId -> session

  server.on('upgrade', (req, socket) => {
    const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return reject(400, 'Bad Request'); }
    if (url.pathname !== '/api/studio/ws') return; // another handler (or the final 404) deals with it
    req.wsHandled = true;
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) return reject(400, 'Bad Request');
    // Browsers always send Origin on WebSocket handshakes: it must be this very site (blocks cross-site hijacking).
    const origin = req.headers.origin;
    let originHost = '';
    try { originHost = origin ? new URL(origin).host : ''; } catch { /* ignore */ }
    if (!originHost || originHost !== req.headers.host) return reject(403, 'Forbidden');
    const user = store.getSessionUser(parseCookies(req).sid);
    if (!user || !user.active) return reject(401, 'Unauthorized');

    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
    socket.setNoDelay(true);
    handle(user, socket);
  });

  function handle(user, socket) {
    const send = (obj) => { if (!socket.destroyed) socket.write(encodeText(JSON.stringify(obj))); };
    let proc = null; let started = false; let ended = false; let intentional = false; let lastLine = '';
    let bytes = 0; let filtered = false;

    const finish = (why, notifyClient = true) => {
      if (ended) return; ended = true;
      if (active.get(user.id) === session) active.delete(user.id);
      if (filtered) relay.setFilter(user.ingest_key, null);
      if (intentional) relay.noteExpectedDrop?.(user.ingest_key);
      try { proc?.stdin?.end(); } catch { /* ignore */ }
      if (proc) setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 4000).unref?.();
      if (started) {
        store.addActivity?.(user.id, 'studio_stopped', `${Math.round(bytes / 1048576)} MB`);
        onEvent({ type: 'studio_stopped', userId: user.id, detail: why });
      }
      if (notifyClient && !socket.destroyed) { send({ type: 'ended', reason: why }); socket.end(encodeClose(1000)); }
      else socket.destroy();
    };
    const session = { stop: () => { intentional = true; finish('Stopped'); } };

    const parser = new FrameParser({
      onPing: (d) => socket.write(encodeFrame(0xA, d)),
      onClose: () => { intentional = intentional || !proc; finish('Closed', false); },
      onMessage: (isBinary, data) => {
        if (isBinary) {
          if (!proc || ended) return;
          bytes += data.length;
          if (proc.stdin.writableLength > maxBuffered) { send({ type: 'error', message: 'Server cannot keep up. Lower the quality.' }); return finish('Too slow'); }
          proc.stdin.write(data);
          return;
        }
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'stop') { intentional = true; return finish('Stopped'); }
        if (m.type !== 'start' || proc) return;

        if (active.has(user.id)) return send({ type: 'error', message: 'Studio is already live in another tab.' }) || finish('Busy');
        if (relay.isIngestLive(user.ingest_key)) return send({ type: 'error', message: 'You are already live (OBS or a scheduled video). Stop that first.' }) || finish('Busy');
        if (!store.listEnabledDestinations(user.id).length) return send({ type: 'error', message: 'No enabled destination. Add one first.' }) || finish('No destination');

        // Optional: only some destinations (checked in the studio screen).
        if (Array.isArray(m.dest_ids)) {
          const ok = store.listEnabledDestinations(user.id).map((d) => d.id).filter((id) => m.dest_ids.includes(id));
          if (!ok.length) return send({ type: 'error', message: 'Pick at least one enabled destination.' }) || finish('No destination');
          relay.setFilter(user.ingest_key, ok); filtered = true;
        }
        const height = QUALITY[m.height] ? m.height : 720;
        const args = buildStudioArgs({ output: `${cfg.mediamtxRtmp}/live/${user.ingest_key}`, hasAudio: m.audio !== false, height, kbps: QUALITY[height] });
        try { proc = spawn(cfg.ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { send({ type: 'error', message: `Cannot start ffmpeg: ${e.message}` }); return finish('ffmpeg missing'); }
        started = true; active.set(user.id, session);
        proc.stderr?.on('data', (c) => { const l = String(c).split(/\r?\n/).filter(Boolean); if (l.length) lastLine = l[l.length - 1].slice(0, 300); });
        proc.stdin?.on('error', () => {});
        proc.on('error', (e) => { lastLine = e.code === 'ENOENT' ? 'ffmpeg not found on the server' : e.message; });
        proc.on('close', (code) => {
          if (ended) return;
          send({ type: 'error', message: lastLine || `Encoder stopped (${code})` });
          finish('Encoder stopped');
        });
        store.addActivity?.(user.id, 'studio_started', `${height}p`);
        onEvent({ type: 'studio_started', userId: user.id });
        send({ type: 'ready', height });
      },
    });

    socket.on('data', (c) => { try { parser.push(c); } catch (e) { log.warn?.('studio ws protocol error', e.message); intentional = false; finish('Protocol error', false); } });
    socket.on('end', () => socket.destroy());
    socket.on('close', () => { intentional = intentional || !started; finish('Connection lost', false); });
    socket.on('error', () => {});
  }

  return { active, stopAll: () => { for (const s of active.values()) s.stop(); } };
}
