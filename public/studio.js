// Browser studio: draws scenes + overlays on a canvas, records it with MediaRecorder and streams
// the chunks over a WebSocket to the server, which turns them into RTMP (see src/studio.js).
const $ = (id) => document.getElementById(id);
const W = 1280; const H = 720;
const SCENES = [['cam', 'Camera'], ['screen', 'Screen'], ['pip', 'Screen + camera'], ['media', 'Media'], ['guest', 'Guest'], ['grid', 'Host + guests'], ['standby', 'Standby']];
const guests = new Map(); // id -> { name, pc, video }
let hostWs = null;

const st = { cam: null, screen: null, scene: 'cam', logo: null, ws: null, rec: null, live: false, audioCtx: null, dest: null, mixed: new Map(), gains: new Map(), t0: 0, timerEnd: 0 };
const vid = (stream) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; v.play().catch(() => {}); return v; };
const say = (m) => { $('st-msg').textContent = m || ''; };
const badge = (t, cls = '') => { const b = $('st-badge'); b.textContent = t; b.className = `badge ${cls}`; };

function ensureAudio() {
  if (!st.audioCtx) { st.audioCtx = new AudioContext(); st.dest = st.audioCtx.createMediaStreamDestination(); }
  return st.audioCtx;
}
function addNode(node, key) {
  const ctx = ensureAudio();
  st.mixed.get(key)?.disconnect(); st.gains.get(key)?.disconnect();
  const gain = ctx.createGain(); gain.gain.value = st.gains.get(key)?.userVolume ?? 1; gain.userVolume = gain.gain.value; gain.muted = st.gains.get(key)?.muted || false;
  if (gain.muted) gain.gain.value = 0;
  node.connect(gain); gain.connect(st.dest);
  st.mixed.set(key, node); st.gains.set(key, gain); renderMixer();
}
function addAudio(stream, key) {
  if (!stream.getAudioTracks().length) return;
  addNode(ensureAudio().createMediaStreamSource(new MediaStream(stream.getAudioTracks())), key);
}
function removeAudio(key) { st.mixed.get(key)?.disconnect(); st.gains.get(key)?.disconnect(); st.mixed.delete(key); st.gains.delete(key); renderMixer(); }
function renderMixer() {
  const box = $('st-mixer'); if (!box) return;
  const label = (k) => (k === 'cam' ? 'Microphone' : k === 'screen' ? 'Screen sound' : k === 'media' ? 'Media sound' : (guests.get(Number(k.slice(1)))?.name || 'Guest'));
  box.replaceChildren(...[...st.gains].map(([k, g]) => {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'grow'; name.textContent = label(k);
    const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '150'; range.value = String(Math.round(g.userVolume * 100));
    range.addEventListener('input', () => { g.userVolume = Number(range.value) / 100; if (!g.muted) g.gain.value = g.userVolume; });
    const mute = document.createElement('button'); mute.className = 'ghost'; mute.textContent = g.muted ? 'Unmute' : 'Mute';
    mute.addEventListener('click', () => { g.muted = !g.muted; g.gain.value = g.muted ? 0 : g.userVolume; mute.textContent = g.muted ? 'Unmute' : 'Mute'; });
    row.append(name, range, mute); return row;
  }));
}
function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }

async function useCamera() {
  try {
    stopStream(st.cam);
    const camId = $('st-camdev').value; const micId = $('st-micdev').value;
    st.cam = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30, ...(camId ? { deviceId: { exact: camId } } : {}) },
      audio: { echoCancellation: true, noiseSuppression: true, ...(micId ? { deviceId: { exact: micId } } : {}) } });
    st.camVideo = vid(st.cam); addAudio(st.cam, 'cam'); say('Camera ready'); mark(); fillDevices();
  } catch (e) { say(`Camera/mic not available: ${e.message}`); }
}
async function fillDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, label) => {
      const cur = sel.value; sel.replaceChildren();
      list.filter((d) => d.kind === kind).forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${label} ${i + 1}`; sel.append(o); });
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    };
    fill($('st-camdev'), 'videoinput', 'Camera'); fill($('st-micdev'), 'audioinput', 'Microphone');
  } catch { /* ignore */ }
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

const dims = (v) => [v.videoWidth || v.naturalWidth || v.width || 0, v.videoHeight || v.naturalHeight || v.height || 0];
function cover(ctx, v, x, y, w, h) {
  const [vw0, vh0] = dims(v); const vw = vw0 || w; const vh = vh0 || h;
  const s = Math.max(w / vw, h / vh); const dw = vw * s; const dh = vh * s;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
}
function contain(ctx, v, w, h) {
  const [vw0, vh0] = dims(v); const vw = vw0 || w; const vh = vh0 || h;
  const s = Math.min(w / vw, h / vh);
  ctx.drawImage(v, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
}

// ---- media scene (video / images / slides from your computer) ----
const media = { items: [], i: 0, el: null };
function showMedia() {
  const f = media.items[media.i];
  if (media.el?.pause) media.el.pause();
  removeAudio('media'); media.el = null;
  if (!f) { $('st-media-name').textContent = ''; return; }
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('video/')) {
    const v = document.createElement('video'); v.src = url; v.loop = true; v.playsInline = true; v.play().catch(() => {});
    try { ensureAudio(); st.audioCtx.resume(); addNode(st.audioCtx.createMediaElementSource(v), 'media'); } catch { /* ignore */ }
    media.el = v;
  } else { const img = new Image(); img.src = url; media.el = img; }
  $('st-media-name').textContent = `${media.i + 1}/${media.items.length}  ${f.name}`;
  setScene('media');
}
const pen = { on: false, strokes: [], cur: null };
let chatMsg = null;

// ---- layout the user can drag on the preview ----
const layout = { pip: { x: W - 344, y: H - 204, w: 320 }, lower: { x: 40, y: H - 190 }, logo: { x: W - 200, y: 24, h: 90 }, timer: { x: 24, y: 24 }, chat: { x: 40, y: H - 280 } };
let hits = []; let drag = null;
const toCanvas = (e) => { const r = $('st-canvas').getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
const hitAt = (x, y) => [...hits].reverse().find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
function drawCamera(ctx, v, x, y, w, h) {
  const b = $('st-bright').value; const c = $('st-contrast').value; const sa = $('st-sat').value;
  ctx.save();
  if (b !== '100' || c !== '100' || sa !== '100') ctx.filter = `brightness(${b}%) contrast(${c}%) saturate(${sa}%)`;
  if ($('st-mirror').checked) { ctx.translate(x + w / 2, 0); ctx.scale(-1, 1); ctx.translate(-(x + w / 2), 0); }
  cover(ctx, keyed(v), x, y, w, h);
  ctx.restore();
}
function drawPip(ctx, v) {
  const { x, y, w } = layout.pip; const h = Math.round(w * 9 / 16);
  drawCamera(ctx, v, x, y, w, h);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
  hits.push({ id: 'pip', x, y, w, h });
}

// ---- background + green screen (removes a green backdrop behind the person, no AI needed) ----
const bg = { mode: 'black', color: '#1d2b64', img: null };

// ---- AI background (person cut-out with MediaPipe, loaded only when chosen; files are installed by the Docker build) ----
const seg = { mode: 'none', model: null, loading: false, ready: false, busy: false, out: document.createElement('canvas') };
seg.out.width = 960; seg.out.height = 540; const sctx = seg.out.getContext('2d');
function loadScript(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('missing')); document.head.append(s); });
}
async function ensureSeg() {
  if (seg.ready || seg.loading) return;
  seg.loading = true; say('Loading AI background…');
  try {
    await loadScript('/vendor/selfie/selfie_segmentation.js');
    const m = new window.SelfieSegmentation({ locateFile: (f) => `/vendor/selfie/${f}` });
    m.setOptions({ modelSelection: 1 });
    m.onResults((r) => {
      sctx.save(); sctx.clearRect(0, 0, 960, 540);
      sctx.drawImage(r.segmentationMask, 0, 0, 960, 540);
      sctx.globalCompositeOperation = 'source-in'; sctx.drawImage(r.image, 0, 0, 960, 540);
      if (seg.mode === 'blur') { sctx.globalCompositeOperation = 'destination-over'; sctx.filter = 'blur(14px)'; sctx.drawImage(r.image, 0, 0, 960, 540); }
      sctx.restore(); seg.have = true;
    });
    await m.initialize(); seg.model = m; seg.ready = true; say('AI background ready.');
    pumpSeg();
  } catch {
    say('AI background is not installed on this server (the Docker build needs internet). Green screen still works.');
    $('st-cambg').value = 'none'; seg.mode = 'none';
  } finally { seg.loading = false; }
}
async function pumpSeg() {
  if (seg.busy || !seg.ready) return;
  seg.busy = true;
  try {
    while (seg.mode !== 'none') {
      if (st.camVideo?.videoWidth) await seg.model.send({ image: st.camVideo });
      await new Promise((r) => setTimeout(r, 30));
    }
  } catch { say('AI background stopped.'); seg.mode = 'none'; $('st-cambg').value = 'none'; }
  seg.busy = false;
}
const kc = document.createElement('canvas'); kc.width = 960; kc.height = 540; const kctx = kc.getContext('2d', { willReadFrequently: true });
const keyedPip = document.createElement('canvas'); keyedPip.width = 960; keyedPip.height = 540;
let lastKey = 0;
function keyed(v) {
  if (seg.mode !== 'none' && seg.ready && seg.have && v === st.camVideo) return seg.out;
  if (!$('st-key').checked || v !== st.camVideo || !v.videoWidth) return v;
  const stamp = performance.now();
  if (stamp - lastKey < 12) return kc; // already processed this frame
  lastKey = stamp;
  cover(kctx, v, 0, 0, 960, 540);
  const img = kctx.getImageData(0, 0, 960, 540); const d = img.data;
  const t1 = Number($('st-key-level').value); const t0 = t1 * 0.45;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    const m = r > b ? r : b; const diff = g - m;
    if (diff > t1) d[i + 3] = 0;
    else if (diff > t0) { d[i + 3] = (255 * (t1 - diff)) / (t1 - t0); d[i + 1] = m; } // soft edge + remove green spill
  }
  kctx.putImageData(img, 0, 0);
  return kc;
}
function drawBackground(ctx) {
  if (bg.mode === 'color') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
  else if (bg.mode === 'image' && bg.img) cover(ctx, bg.img, 0, 0, W, H);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
}

function draw(now) {
  const c = $('st-canvas'); const ctx = c.getContext('2d');
  hits = [];
  drawBackground(ctx);
  const scene = st.scene;
  if (scene === 'cam' && st.camVideo) drawCamera(ctx, st.camVideo, 0, 0, W, H);
  else if (scene === 'media' && media.el) contain(ctx, media.el, W, H);
  else if (scene === 'screen' && st.screenVideo) contain(ctx, st.screenVideo, W, H);
  else if (scene === 'pip' && st.screenVideo) {
    contain(ctx, st.screenVideo, W, H);
    if (st.camVideo) drawPip(ctx, st.camVideo);
  } else if (scene === 'guest' || scene === 'grid') {
    const gs = [...guests.values()].filter((g) => g.video && g.video.videoWidth);
    if (scene === 'guest' && gs.length) {
      cover(ctx, gs[0].video, 0, 0, W, H);
      if (st.camVideo) drawPip(ctx, st.camVideo);
    } else {
      const tiles = [st.camVideo && { v: st.camVideo, n: '' }, ...gs.map((g) => ({ v: g.video, n: g.name }))].filter(Boolean);
      if (!tiles.length) { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.font = '32px sans-serif'; ctx.fillText('Waiting for guests…', W / 2, H / 2); ctx.textAlign = 'left'; }
      const cols = tiles.length <= 1 ? 1 : 2; const rows = Math.ceil(tiles.length / cols);
      const tw = W / cols; const th = H / rows;
      tiles.forEach((t, i) => {
        const x = (i % cols) * tw; const y = Math.floor(i / cols) * th;
        if (t.v === st.camVideo) drawCamera(ctx, t.v, x + 2, y + 2, tw - 4, th - 4); else cover(ctx, t.v, x + 2, y + 2, tw - 4, th - 4);
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
  if (st.logo && scene !== 'standby') {
    const { x, y, h } = layout.logo; const w = st.logo.width * (h / st.logo.height);
    ctx.drawImage(st.logo, x, y, w, h); hits.push({ id: 'logo', x, y, w, h });
  }
  const lower = $('st-lower').value.trim();
  if (lower && scene !== 'standby') {
    const { x, y } = layout.lower;
    ctx.font = 'bold 38px sans-serif'; const tw = Math.min(ctx.measureText(lower).width + 48, W - 120);
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x, y, tw, 64);
    ctx.fillStyle = '#ffcc00'; ctx.fillRect(x, y, 8, 64);
    ctx.fillStyle = '#fff'; ctx.fillText(lower, x + 24, y + 46, tw - 40);
    hits.push({ id: 'lower', x, y, w: tw, h: 64 });
  }
  const tm = $('st-timer').value;
  if (tm !== 'none' && scene !== 'standby') {
    let txt; let late = false;
    if (tm === 'clock') txt = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    else if (!st.timerEnd) txt = '--:--';
    else { const left = Math.max(0, Math.ceil((st.timerEnd - Date.now()) / 1000)); late = left === 0; txt = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; }
    ctx.font = 'bold 54px sans-serif'; const w = ctx.measureText(txt).width + 40; const { x, y } = layout.timer;
    ctx.fillStyle = late ? 'rgba(180,0,0,.85)' : 'rgba(0,0,0,.65)'; ctx.fillRect(x, y, w, 76);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, x + 20, y + 56); hits.push({ id: 'timer', x, y, w, h: 76 });
  }
  if (chatMsg && chatMsg.until > Date.now() && scene !== 'standby') {
    const { x, y } = layout.chat; ctx.font = 'bold 30px sans-serif';
    const line = `${chatMsg.author}: ${chatMsg.text}`; const w = Math.min(ctx.measureText(line).width + 48, W - 80);
    ctx.fillStyle = 'rgba(255,255,255,.93)'; ctx.fillRect(x, y, w, 56);
    ctx.fillStyle = '#111'; ctx.fillText(line, x + 24, y + 38, w - 40); hits.push({ id: 'chat', x, y, w, h: 56 });
  }
  for (const stroke of pen.strokes) {
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    stroke.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); if (stroke.pts.length === 1) ctx.lineTo(stroke.pts[0][0] + 0.1, stroke.pts[0][1]); ctx.stroke();
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
// Optional: show guests the live output (low frame rate to spare the host's CPU).
let progStream = null;
async function sendProgram(g) {
  const t = g.pc.getTransceivers().find((x) => x.receiver.track.kind === 'video');
  if (!t) return;
  if ($('st-return').checked) {
    progStream = progStream || $('st-canvas').captureStream(15);
    await t.sender.replaceTrack(progStream.getVideoTracks()[0]); t.direction = 'sendrecv';
  } else { await t.sender.replaceTrack(null); }
}
function dropGuest(id) {
  const g = guests.get(id); if (!g) return;
  try { g.pc.close(); } catch { /* ignore */ }
  removeAudio(`g${id}`);
  guests.delete(id); renderGuests();
}
async function onGuestSignal(id, signal) {
  const g = guests.get(id); if (!g) return;
  if (signal.sdp) {
    await g.pc.setRemoteDescription(signal.sdp);
    const mic = st.cam?.getAudioTracks()[0];
    const t = g.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio');
    if (t && mic) { await t.sender.replaceTrack(mic); t.direction = 'sendrecv'; } // guest hears the host
    await sendProgram(g);
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

// ---- record from the studio (camera, screen, scenes, overlays) and keep it as a video to schedule later ----
let local = null;
function toggleRecord() {
  if (local) { local.rec.stop(); return; }
  if (!st.cam && !st.screen) return say('Turn on camera or share your screen first.');
  const mime = pickMime(); if (!mime) return say('This browser cannot record video. Use Chrome or Edge.');
  ensureAudio(); st.audioCtx.resume();
  const stream = $('st-canvas').captureStream(30);
  if (st.mixed.size) st.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000 });
  const chunks = []; const t0 = Date.now();
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const timer = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    $('st-rec').textContent = `■ Stop and save (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')})`;
    if (sec > 90 * 60) rec.stop();
  }, 500);
  rec.onstop = () => {
    clearInterval(timer); local = null; $('st-rec').textContent = '● Record';
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const name = `Studio ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.webm`;
    const file = new File([blob], name, { type: 'video/webm' });
    say('Saving to Videos…');
    window.dispatchEvent(new CustomEvent('vs-upload', { detail: { file,
      onProgress: (p) => say(`Saving to Videos… ${Math.round(p * 100)}%`),
      onDone: () => say('Saved. Find it under Videos & schedule (it is prepared there, then you can schedule it).'),
      onError: (m) => say(`Could not save: ${m}`) } }));
  };
  rec.start(2000); local = { rec };
  $('st-rec').textContent = '■ Stop and save (0:00)';
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
  const groups = [...new Set(on.map((d) => d.group_name).filter(Boolean))];
  for (const g of groups) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = `Group: ${g}`;
    b.addEventListener('click', () => {
      const inputs = [...box.querySelectorAll('input')].filter((i) => on.find((d) => String(d.id) === i.value)?.group_name === g);
      const all = inputs.every((i) => i.checked); inputs.forEach((i) => { i.checked = !all; });
    });
    box.append(b);
  }
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

// ---- unified live chat (YouTube through your connected channel, Twitch read-only) ----
const chat = { items: [], tw: null, ytId: null, ytRun: 0 };
function addChat(src, author, text) {
  chat.items.push({ src, author, text }); if (chat.items.length > 120) chat.items.shift();
  const ul = $('chat-list'); const stick = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 30;
  ul.replaceChildren(...chat.items.map((m) => {
    const li = document.createElement('li'); const t = document.createElement('div'); t.className = 'grow';
    t.textContent = `[${m.src}] ${m.author}: ${m.text}`;
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Show';
    b.addEventListener('click', () => { chatMsg = { author: m.author, text: m.text, until: Date.now() + 15000 }; });
    li.append(t, b); return li;
  }));
  if (stick) ul.scrollTop = ul.scrollHeight;
}
function connectTwitch() {
  const ch = $('chat-twitch').value.trim().replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(ch)) return say('Enter the Twitch channel name.');
  try { chat.tw?.close(); } catch { /* ignore */ }
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); chat.tw = ws;
  ws.onopen = () => { ws.send('PASS SCHMOOPIIE'); ws.send(`NICK justinfan${Math.floor(Math.random() * 90000 + 10000)}`); ws.send(`JOIN #${ch}`); say(`Twitch chat: ${ch}`); };
  ws.onmessage = (ev) => {
    for (const line of String(ev.data).split('\r\n')) {
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      const m = /^(?:@\S+ )?:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\S+ :(.*)$/.exec(line);
      if (m) addChat('Twitch', m[1], m[2]);
    }
  };
  ws.onerror = () => say('Could not reach Twitch chat.');
}
async function pollYouTube(run, id) {
  let page = '';
  while (chat.ytRun === run) {
    let wait = 6000;
    try {
      const res = await fetch(`/api/chat/youtube?connection=${id}&page=${encodeURIComponent(page)}`, { credentials: 'same-origin', headers: { 'x-requested-with': 'vivid' } });
      const data = await res.json();
      if (!res.ok) { say(data.error || 'YouTube chat error'); wait = 15000; } else { for (const m of data.messages) addChat('YouTube', m.author, m.text); page = data.next || page; wait = data.waitMs; }
    } catch { wait = 15000; }
    await new Promise((r) => setTimeout(r, wait));
  }
}
async function initChat() {
  $('chat-twitch-go').addEventListener('click', connectTwitch);
  $('chat-yt-go').addEventListener('click', () => {
    const id = $('chat-yt').value; if (!id) return say('Connect your YouTube channel first (Destinations tab).');
    chat.ytRun += 1; pollYouTube(chat.ytRun, id); say('YouTube chat started. It works while your YouTube live is running.');
  });
  try {
    const r = await fetch('/api/connections', { credentials: 'same-origin' }); if (!r.ok) return;
    const { connections } = await r.json();
    const sel = $('chat-yt'); sel.replaceChildren();
    for (const c of connections.filter((x) => x.provider === 'google')) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.account_name; sel.append(o); }
  } catch { /* chat from YouTube is optional */ }
}

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
  const cv = $('st-canvas');
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = toCanvas(e);
    if (pen.on) { pen.cur = { color: $('st-pen').value, w: 5, pts: [[x, y]] }; pen.strokes.push(pen.cur); cv.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    const h = hitAt(x, y); if (!h) return;
    const o = layout[h.id]; drag = { id: h.id, dx: x - o.x, dy: y - o.y, w: h.w, h: h.h };
    cv.setPointerCapture(e.pointerId); e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = toCanvas(e);
    if (pen.cur) { pen.cur.pts.push([x, y]); return; }
    if (!drag) { cv.style.cursor = hitAt(x, y) ? 'move' : 'default'; return; }
    const o = layout[drag.id];
    o.x = Math.max(0, Math.min(W - drag.w, x - drag.dx)); o.y = Math.max(0, Math.min(H - drag.h, y - drag.dy));
  });
  for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, () => { drag = null; pen.cur = null; });
  $('st-pip-size').addEventListener('input', (e) => { layout.pip.w = Number(e.target.value); layout.pip.x = Math.min(layout.pip.x, W - layout.pip.w); });
  $('st-logo-size').addEventListener('input', (e) => { layout.logo.h = Number(e.target.value); });
  $('st-bg').addEventListener('change', (e) => {
    bg.mode = e.target.value;
    $('st-bg-color').classList.toggle('hidden', bg.mode !== 'color');
    $('st-bg-file').classList.toggle('hidden', bg.mode !== 'image');
  });
  $('st-bg-color').addEventListener('input', (e) => { bg.color = e.target.value; });
  $('st-bg-file').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => { bg.img = img; }; img.src = URL.createObjectURL(f);
  });
  $('st-cambg').addEventListener('change', async (e) => {
    seg.mode = e.target.value;
    if (seg.mode === 'none') return;
    await ensureSeg(); if (seg.ready) pumpSeg();
  });
  $('st-camdev').addEventListener('change', () => { if (st.cam) useCamera(); });
  $('st-micdev').addEventListener('change', () => { if (st.cam) useCamera(); });
  $('st-media-files').addEventListener('change', (e) => { media.items = [...e.target.files]; media.i = 0; showMedia(); });
  $('st-media-next').addEventListener('click', () => { if (media.items.length) { media.i = (media.i + 1) % media.items.length; showMedia(); } });
  $('st-media-prev').addEventListener('click', () => { if (media.items.length) { media.i = (media.i - 1 + media.items.length) % media.items.length; showMedia(); } });
  $('st-media-play').addEventListener('click', () => { const v = media.el; if (v?.pause) { if (v.paused) v.play(); else v.pause(); } });
  $('st-timer-start').addEventListener('click', () => { st.timerEnd = Date.now() + Math.max(1, Number($('st-timer-min').value) || 1) * 60000; $('st-timer').value = 'countdown'; });
  $('st-draw').addEventListener('click', () => { pen.on = !pen.on; $('st-draw').classList.toggle('on', pen.on); $('st-canvas').style.cursor = pen.on ? 'crosshair' : 'default'; });
  $('st-clear').addEventListener('click', () => { pen.strokes.length = 0; });
  $('st-snap').addEventListener('click', () => {
    $('st-canvas').toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `snapshot-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
  });
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('app').classList.contains('hidden')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= SCENES.length) setScene(SCENES[n - 1][0]);
    else if (e.key === 'ArrowRight') $('st-media-next').click();
    else if (e.key === 'ArrowLeft') $('st-media-prev').click();
    else if (e.key.toLowerCase() === 'd') $('st-draw').click();
  });
  initChat();
  $('st-rec').addEventListener('click', toggleRecord);
  $('st-start').addEventListener('click', goLive);
  $('st-invite').addEventListener('click', invite);
  $('st-return').addEventListener('change', () => { for (const g of guests.values()) sendProgram(g).catch(() => {}); });
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
