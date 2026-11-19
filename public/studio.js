// Browser studio: draws scenes + overlays on a canvas, records it with MediaRecorder and streams
// the chunks over a WebSocket to the server, which turns them into RTMP (see src/studio.js).
const $ = (id) => document.getElementById(id);
const W = 1280; const H = 720;
const SCENES = [['cam', 'Camera'], ['screen', 'Screen'], ['pip', 'Screen + camera'], ['guest', 'Guest'], ['grid', 'Host + guests'], ['standby', 'Standby']];
const guests = new Map(); // id -> { name, pc, video }
let hostWs = null;

const st = { cam: null, screen: null, scene: 'cam', logo: null, ws: null, rec: null, live: false, audioCtx: null, dest: null, mixed: new Map(), t0: 0 };
const vid = (stream) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; v.play().catch(() => {}); return v; };
const say = (m) => { $('st-msg').textContent = m || ''; };
const badge = (t, cls = '') => { const b = $('st-badge'); b.textContent = t; b.className = `badge ${cls}`; };

function ensureAudio() {
  if (!st.audioCtx) { st.audioCtx = new AudioContext(); st.dest = st.audioCtx.createMediaStreamDestination(); }
  return st.audioCtx;
}
function addAudio(stream, key) {
  if (!stream.getAudioTracks().length) return;
  const ctx = ensureAudio();
  st.mixed.get(key)?.disconnect();
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  src.connect(st.dest); st.mixed.set(key, src);
}
function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }

async function useCamera() {
  try {
    stopStream(st.cam);
    st.cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: { echoCancellation: true, noiseSuppression: true } });
    st.camVideo = vid(st.cam); addAudio(st.cam, 'cam'); say('Camera ready'); mark();
  } catch (e) { say(`Camera/mic not available: ${e.message}`); }
}
async function useScreen() {
  try {
    stopStream(st.screen);
    st.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    st.screenVideo = vid(st.screen); addAudio(st.screen, 'screen');
    st.screen.getVideoTracks()[0].addEventListener('ended', () => { st.screen = null; st.screenVideo = null; if (st.scene !== 'cam') setScene('cam'); mark(); });
    setScene('screen'); say('Screen shared'); mark();
  } catch (e) { say(`Screen share cancelled: ${e.message}`); }
}
function mark() {
  $('st-cam').classList.toggle('on', !!st.cam);
  $('st-screen').classList.toggle('on', !!st.screen);
}
function setScene(id) {
  st.scene = id;
  for (const b of $('st-scenes').children) b.classList.toggle('on', b.dataset.id === id);
}

function cover(ctx, v, x, y, w, h) {
  const vw = v.videoWidth || w; const vh = v.videoHeight || h;
  const s = Math.max(w / vw, h / vh); const dw = vw * s; const dh = vh * s;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
}
function contain(ctx, v, w, h) {
  const vw = v.videoWidth || w; const vh = v.videoHeight || h;
  const s = Math.min(w / vw, h / vh);
  ctx.drawImage(v, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
}

function draw(now) {
  const c = $('st-canvas'); const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const scene = st.scene;
  if (scene === 'cam' && st.camVideo) cover(ctx, st.camVideo, 0, 0, W, H);
  else if (scene === 'screen' && st.screenVideo) contain(ctx, st.screenVideo, W, H);
  else if (scene === 'pip' && st.screenVideo) {
    contain(ctx, st.screenVideo, W, H);
    if (st.camVideo) {
      const w = 320; const h = 180; const x = W - w - 24; const y = H - h - 24;
      cover(ctx, st.camVideo, x, y, w, h);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    }
  } else if (scene === 'guest' || scene === 'grid') {
    const gs = [...guests.values()].filter((g) => g.video && g.video.videoWidth);
    if (scene === 'guest' && gs.length) {
      cover(ctx, gs[0].video, 0, 0, W, H);
      if (st.camVideo) { const w = 320; const h = 180; cover(ctx, st.camVideo, W - w - 24, H - h - 24, w, h); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(W - w - 24, H - h - 24, w, h); }
    } else {
      const tiles = [st.camVideo && { v: st.camVideo, n: '' }, ...gs.map((g) => ({ v: g.video, n: g.name }))].filter(Boolean);
      if (!tiles.length) { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.font = '32px sans-serif'; ctx.fillText('Waiting for guests…', W / 2, H / 2); ctx.textAlign = 'left'; }
      const cols = tiles.length <= 1 ? 1 : 2; const rows = Math.ceil(tiles.length / cols);
      const tw = W / cols; const th = H / rows;
      tiles.forEach((t, i) => {
        const x = (i % cols) * tw; const y = Math.floor(i / cols) * th;
        cover(ctx, t.v, x + 2, y + 2, tw - 4, th - 4);
        if (t.n) { ctx.font = 'bold 28px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 12, y + th - 56, ctx.measureText(t.n).width + 24, 40); ctx.fillStyle = '#fff'; ctx.fillText(t.n, x + 24, y + th - 26); }
      });
    }
  } else if (scene === 'standby') {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1d2b64'); g.addColorStop(1, '#6a3093');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 64px sans-serif';
    ctx.fillText($('st-standby').value || 'We will be back shortly', W / 2, H / 2, W - 120);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.font = '32px sans-serif';
    ctx.fillText('Choose Camera or Share screen', W / 2, H / 2); ctx.textAlign = 'left';
  }
  // overlays (not on standby, which has its own text)
  if (st.logo && scene !== 'standby') { const h = 90; const w = st.logo.width * (h / st.logo.height); ctx.drawImage(st.logo, W - w - 24, 24, w, h); }
  const lower = $('st-lower').value.trim();
  if (lower && scene !== 'standby') {
    ctx.font = 'bold 38px sans-serif'; const tw = Math.min(ctx.measureText(lower).width + 48, W - 120);
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(40, H - 190, tw, 64);
    ctx.fillStyle = '#ffcc00'; ctx.fillRect(40, H - 190, 8, 64);
    ctx.fillStyle = '#fff'; ctx.fillText(lower, 64, H - 144, tw - 40);
  }
  const tick = $('st-ticker').value.trim();
  if (tick && scene !== 'standby') {
    ctx.fillStyle = 'rgba(180,0,0,.9)'; ctx.fillRect(0, H - 56, W, 56);
    ctx.font = 'bold 30px sans-serif'; ctx.fillStyle = '#fff';
    const tw = ctx.measureText(tick).width + 200; const x = W - ((now / 12) % (tw + W));
    ctx.fillText(tick, x, H - 16);
  }
  requestAnimationFrame(draw);
}

// ---- guests (WebRTC to the host's browser; the server only relays signalling) ----
function renderGuests() {
  const ul = $('st-guests'); ul.replaceChildren();
  for (const [id, g] of guests) {
    const li = document.createElement('li'); const span = document.createElement('div'); span.className = 'grow'; span.textContent = g.name;
    const b = document.createElement('button'); b.className = 'danger'; b.textContent = 'Remove';
    b.addEventListener('click', () => hostWs?.send(JSON.stringify({ type: 'kick', to: id })));
    li.append(span, b); ul.append(li);
  }
}
function newGuest(id, name) {
  if (guests.has(id)) return guests.get(id);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
  const g = { name, pc, video: null };
  pc.onicecandidate = (e) => { if (e.candidate) hostWs?.send(JSON.stringify({ to: id, signal: { candidate: e.candidate } })); };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') { g.video = vid(stream); }
    else {
      const a = document.createElement('audio'); a.muted = true; a.autoplay = true; a.srcObject = stream; a.play().catch(() => {}); g.audioEl = a; // Chrome needs a sink for WebAudio to see remote audio
      addAudio(new MediaStream([e.track]), `g${id}`);
    }
  };
  guests.set(id, g); renderGuests();
  return g;
}
function dropGuest(id) {
  const g = guests.get(id); if (!g) return;
  try { g.pc.close(); } catch { /* ignore */ }
  st.mixed.get(`g${id}`)?.disconnect(); st.mixed.delete(`g${id}`);
  guests.delete(id); renderGuests();
}
async function onGuestSignal(id, signal) {
  const g = guests.get(id); if (!g) return;
  if (signal.sdp) {
    await g.pc.setRemoteDescription(signal.sdp);
    const mic = st.cam?.getAudioTracks()[0];
    const t = g.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio');
    if (t && mic) { await t.sender.replaceTrack(mic); t.direction = 'sendrecv'; } // guest hears the host
    const answer = await g.pc.createAnswer();
    await g.pc.setLocalDescription(answer);
    hostWs?.send(JSON.stringify({ to: id, signal: { sdp: g.pc.localDescription } }));
  } else if (signal.candidate) await g.pc.addIceCandidate(signal.candidate).catch(() => {});
}
async function invite() {
  const res = await fetch('/api/studio/invite', { method: 'POST', headers: { 'x-requested-with': 'vivid', 'content-type': 'application/json' }, credentials: 'same-origin', body: '{}' });
  if (!res.ok) return say('Could not create invite.');
  const { token, url } = await res.json();
  $('st-invite-link').value = `${location.origin}${url}`;
  $('st-invite-box').classList.remove('hidden');
  try { hostWs?.close(); } catch { /* ignore */ }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/guest/host?token=${encodeURIComponent(token)}`);
  hostWs = ws;
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'host-ready') for (const g of m.guests) newGuest(g.id, g.name);
    else if (m.type === 'guest-joined') newGuest(m.id, m.name);
    else if (m.type === 'guest-left') dropGuest(m.id);
    else if (m.type === 'signal') await onGuestSignal(m.from, m.signal);
    else if (m.type === 'error') say(m.message);
  };
  ws.onclose = () => { for (const id of [...guests.keys()]) dropGuest(id); if (hostWs === ws) hostWs = null; };
}

function pickMime() {
  for (const m of ['video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm']) if (window.MediaRecorder?.isTypeSupported(m)) return m;
  return '';
}

async function loadDests() {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  if (!res.ok) return;
  const { destinations } = await res.json();
  const box = $('st-dests');
  const prev = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
  box.replaceChildren();
  const on = destinations.filter((d) => d.enabled);
  if (!on.length) box.textContent = 'No enabled destination yet. Add one below.';
  for (const d of on) {
    const l = document.createElement('label'); const i = document.createElement('input');
    i.type = 'checkbox'; i.value = d.id; i.checked = prev.size ? prev.has(String(d.id)) : true; i.dataset.dest = d.id;
    l.append(i, document.createTextNode(` ${d.name}`)); box.append(l);
  }
}

function goLive() {
  if (st.live) return;
  if (!st.cam && !st.screen) return say('Turn on camera or share your screen first.');
  const mime = pickMime();
  if (!mime) return say('This browser cannot record video. Use Chrome or Edge.');
  const ids = [...$('st-dests').querySelectorAll('input:checked')].map((i) => Number(i.value));
  if (!ids.length) return say('Tick at least one destination.');
  ensureAudio(); st.audioCtx.resume();
  const hasAudio = st.mixed.size > 0;
  const height = Number($('st-quality').value);
  const stream = $('st-canvas').captureStream(30);
  if (hasAudio) st.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/studio/ws`);
  ws.binaryType = 'arraybuffer'; st.ws = ws;
  badge('Connecting…', 'warn'); $('st-start').disabled = true;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', audio: hasAudio, height, dest_ids: ids }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ready') {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: { 480: 1_500_000, 720: 3_000_000, 1080: 5_000_000 }[height], audioBitsPerSecond: 128_000 });
      rec.ondataavailable = (e) => {
        if (!e.data.size || ws.readyState !== 1) return;
        if (ws.bufferedAmount > 8 * 1024 * 1024) say('Your internet is too slow for this quality. Choose 480p.');
        e.data.arrayBuffer().then((b) => ws.readyState === 1 && ws.send(b));
      };
      rec.start(1000); st.rec = rec; st.live = true; st.t0 = Date.now();
      badge('LIVE', 'ok'); say('Streaming. Check YouTube Studio / Facebook in a few seconds.');
      $('st-stop').classList.remove('hidden'); $('st-start').classList.add('hidden'); $('st-start').disabled = false;
    } else if (m.type === 'error') { say(m.message); } else if (m.type === 'ended') { cleanup(m.reason); }
  };
  ws.onclose = () => cleanup(st.live ? 'Connection lost' : '');
  ws.onerror = () => say('Could not connect to the server.');
}
function cleanup(reason) {
  try { if (st.rec && st.rec.state !== 'inactive') st.rec.stop(); } catch { /* ignore */ }
  st.rec = null; st.live = false;
  badge('Off'); if (reason) say(reason);
  $('st-stop').classList.add('hidden'); $('st-start').classList.remove('hidden'); $('st-start').disabled = false;
  try { st.ws?.close(); } catch { /* ignore */ }
  st.ws = null;
}
function stopLive() { try { st.ws?.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ } setTimeout(() => cleanup('Stopped'), 500); }

function init() {
  if (!$('st-canvas')) return;
  if (!navigator.mediaDevices?.getUserMedia) { $('studio-card').classList.add('hidden'); return; }
  $('st-scenes').replaceChildren(...SCENES.map(([id, label]) => {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = label; b.dataset.id = id;
    b.addEventListener('click', () => setScene(id)); return b;
  }));
  setScene('cam');
  $('st-cam').addEventListener('click', useCamera);
  $('st-screen').addEventListener('click', useScreen);
  $('st-start').addEventListener('click', goLive);
  $('st-invite').addEventListener('click', invite);
  $('st-stop').addEventListener('click', stopLive);
  $('st-logo').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) { st.logo = null; return; }
    const img = new Image(); img.onload = () => { st.logo = img; }; img.src = URL.createObjectURL(f);
  });
  // destinations list refreshes when the dashboard becomes visible and every 15 s while not live
  const tick = () => { if (!$('app').classList.contains('hidden') && !st.live) loadDests().catch(() => {}); };
  setInterval(tick, 15000); setTimeout(tick, 1500);
  window.addEventListener('beforeunload', () => { try { st.ws?.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ } });
  requestAnimationFrame(draw);
}
init();
