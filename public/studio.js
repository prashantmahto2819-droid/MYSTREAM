// Browser studio: draws scenes + overlays on a canvas, records it with MediaRecorder and streams
// the chunks over a WebSocket to the server, which turns them into RTMP (see src/studio.js).
import { qrMatrix } from './qr.js';
const $ = (id) => document.getElementById(id);
let W = 1280; let H = 720;
const SCENES = [['cam', 'Camera'], ['screen', 'Screen'], ['pip', 'Screen + camera'], ['side', 'Side by side'], ['media', 'Clip'], ['speaker', 'Speaker'], ['guest', 'Guest'], ['grid', 'Host + guests'], ['cams', 'All cameras'], ['countdown', 'Countdown'], ['standby', 'Standby']];
const guests = new Map(); // id -> { name, pc, video }
let hostWs = null;

const st = { cam: null, screen: null, scene: 'cam', logo: null, ws: null, rec: null, live: false, audioCtx: null, dest: null, mixed: new Map(), gains: new Map(), analysers: new Map(), labels: new Map(), micStreams: new Map(), levels: new Map(), raw: new Map(), extras: [], mainExtra: -1, sent: 0, frames: 0, retries: 0, spk: '', spkAt: 0, t0: 0, timerEnd: 0 };
const vid = (stream) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; v.play().catch(() => {}); return v; };
function toast(m) {
  const box = $('toasts'); if (!m || !box) return;
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = m; box.append(d);
  try { if (!box.matches(':popover-open')) box.showPopover(); } catch { /* old browser: message line still shows it */ }
  setTimeout(() => { d.remove(); if (!box.children.length) { try { box.hidePopover(); } catch { /* ignore */ } } }, 4500);
}
const say = (m) => { $('st-msg').textContent = m || ''; const d = $('dlg-msg'); if (d) d.textContent = m || ''; if (m) toast(m); };
const badge = (t, cls = '') => { const b = $('st-badge'); b.textContent = t; b.className = `badge ${cls}`; };

function ensureAudio() {
  if (!st.audioCtx) {
    st.audioCtx = new AudioContext(); st.dest = st.audioCtx.createMediaStreamDestination();
    // master limiter: stops loud peaks (several mics + music + clips) from clipping the stream
    const lim = st.audioCtx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
    lim.connect(st.dest); st.bus = lim;
  }
  return st.audioCtx;
}
function addNode(node, key) {
  const ctx = ensureAudio();
  st.mixed.get(key)?.disconnect(); st.gains.get(key)?.disconnect();
  const gain = ctx.createGain(); gain.gain.value = st.gains.get(key)?.userVolume ?? 1; gain.userVolume = gain.gain.value; gain.muted = st.gains.get(key)?.muted || false;
  if (gain.muted) gain.gain.value = 0;
  node.connect(gain); gain.connect(st.bus || st.dest);
  const an = ctx.createAnalyser(); an.fftSize = 512; gain.connect(an); st.analysers.set(key, { an, buf: new Uint8Array(an.fftSize) });
  st.mixed.set(key, node); st.gains.set(key, gain); renderMixer();
}
// Voice polish: cuts low rumble (fans, desk bumps) and evens out loud / soft speech, like a podcast chain.
function polish(ctx, src) {
  if (!$('st-polish')?.checked) return src;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 18; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
  src.connect(hp); hp.connect(comp);
  return comp;
}
function addAudio(stream, key) {
  if (!stream.getAudioTracks().length) return;
  const ctx = ensureAudio(); const src = polish(ctx, ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())));
  if (key === 'cam') { const d = ctx.createDelay(1); d.delayTime.value = Number($('st-adelay').value) / 1000; src.connect(d); st.camDelay = d; addNode(d, key); return; }
  addNode(src, key);
}
function removeAudio(key) {
  st.mixed.get(key)?.disconnect(); st.gains.get(key)?.disconnect(); st.mixed.delete(key); st.gains.delete(key); st.analysers.delete(key);
  stopStream(st.micStreams.get(key)); st.micStreams.delete(key); st.labels.delete(key); renderMixer();
}
function toggleMic() {
  const g = st.gains.get('cam'); if (!g) return say('Turn on the camera + mic first.');
  g.muted = !g.muted; g.gain.value = g.muted ? 0 : g.userVolume; renderMixer();
  $('st-mute').textContent = g.muted ? 'Unmute microphone' : 'Mute microphone'; say(g.muted ? 'Microphone muted' : 'Microphone on');
}
function updateLevels() {
  st.raw.clear();
  for (const [k, a] of st.analysers) {
    a.an.getByteTimeDomainData(a.buf); let sum = 0;
    for (const v of a.buf) { const d = (v - 128) / 128; sum += d * d; }
    st.raw.set(k, Math.sqrt(sum / a.buf.length));
  }
  st.levels = new Map(st.raw);
  for (const [k, v] of st.raw) if (k.startsWith('mic:')) st.levels.set('cam', Math.max(st.levels.get('cam') || 0, v));
  for (const [k, m] of meters) m.value = Math.min(100, (st.raw.get(k) || 0) * 350);
}
const meters = new Map();
async function addMic() {
  const id = $('st-micdev').value; if (!id) return say('Choose a microphone in the list first.');
  const key = `mic:${id}`; if (st.gains.has(key)) return say('That microphone is already added.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true } });
    st.micStreams.set(key, stream); st.labels.set(key, $('st-micdev').selectedOptions[0]?.textContent || 'Microphone');
    addAudio(stream, key); say('Microphone added');
  } catch (e) { say(`Microphone not available: ${e.message}`); }
}
// ---- more cameras ----
const mainCam = () => st.extras[st.mainExtra]?.video || st.camVideo || st.extras[0]?.video || null;
async function addCamera() {
  const id = $('st-camdev').value; if (!id) return say('Choose a camera in the list first.');
  if (st.extras.some((x) => x.id === id)) return say('That camera is already added.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30, deviceId: { exact: id } }, audio: false });
    st.extras.push({ id, label: $('st-camdev').selectedOptions[0]?.textContent || 'Camera', stream, video: vid(stream) });
    renderCams(); say('Camera added. Use "All cameras" scene or make it the main camera.');
  } catch (e) { say(`Camera not available: ${e.message}`); }
}
function renderCams() {
  const ul = $('st-camlist'); ul.replaceChildren();
  const row = (label, active, onUse, onRemove) => {
    const li = document.createElement('li'); const d = document.createElement('div'); d.className = 'grow'; d.textContent = label;
    const use = document.createElement('button'); use.className = active ? '' : 'ghost'; use.textContent = active ? 'Main' : 'Make main'; use.addEventListener('click', onUse);
    li.append(d, use);
    if (onRemove) { const rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove'; rm.addEventListener('click', onRemove); li.append(rm); }
    ul.append(li);
  };
  if (st.camVideo) row('Camera 1 (with mic)', st.mainExtra < 0, () => { st.mainExtra = -1; renderCams(); });
  st.extras.forEach((x, i) => row(x.label, st.mainExtra === i, () => { st.mainExtra = i; renderCams(); }, () => {
    stopStream(x.stream); st.extras.splice(i, 1); if (st.mainExtra >= st.extras.length) st.mainExtra = -1; renderCams();
  }));
}
function renderMixer() {
  const box = $('st-mixer'); if (!box) return;
  const label = (k) => (st.labels.get(k) || k === 'cam' ? (st.labels.get(k) || 'Microphone') : k === 'screen' ? 'Screen sound' : k === 'media' ? 'Media sound' : (guests.get(Number(k.slice(1)))?.name || 'Guest'));
  meters.clear();
  box.replaceChildren(...[...st.gains].map(([k, g]) => {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'grow'; name.textContent = label(k);
    const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '150'; range.value = String(Math.round(g.userVolume * 100));
    range.addEventListener('input', () => { g.userVolume = Number(range.value) / 100; if (!g.muted) g.gain.value = g.userVolume; });
    const mute = document.createElement('button'); mute.className = 'ghost'; mute.textContent = g.muted ? 'Unmute' : 'Mute';
    mute.addEventListener('click', () => { g.muted = !g.muted; g.gain.value = g.muted ? 0 : g.userVolume; mute.textContent = g.muted ? 'Unmute' : 'Mute'; });
    const meter = document.createElement('progress'); meter.max = 100; meter.value = 0; meter.style.cssText = 'width:60px;margin:0;height:8px'; meters.set(k, meter);
    row.append(name, meter, range, mute);
    if (k.startsWith('mic:')) { const rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'x'; rm.addEventListener('click', () => removeAudio(k)); row.append(rm); }
    return row;
  }));
}
function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }

async function useCamera() {
  try {
    stopStream(st.cam);
    const camId = $('st-camdev').value; const micId = $('st-micdev').value; const res = $('st-camres').value.split('x').map(Number);
    st.cam = await navigator.mediaDevices.getUserMedia({
      video: { width: res[0], height: res[1], frameRate: Number($('st-camfps').value), ...(camId ? { deviceId: { exact: camId } } : {}) },
      audio: { echoCancellation: $('st-ec').checked, noiseSuppression: $('st-ns').checked, autoGainControl: $('st-agc').checked, ...(micId ? { deviceId: { exact: micId } } : {}) } });
    st.camVideo = vid(st.cam); addAudio(st.cam, 'cam'); say('Camera ready'); mark(); fillDevices(); renderCams();
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
function contain(ctx, v, w, h, x0 = 0, y0 = 0) {
  const [vw0, vh0] = dims(v); const vw = vw0 || w; const vh = vh0 || h;
  const s = Math.min(w / vw, h / vh);
  ctx.drawImage(v, x0 + (w - vw * s) / 2, y0 + (h - vh * s) / 2, vw * s, vh * s);
}

// ---- media scene (video / images / slides from your computer) ----
const media = { items: [], i: 0, el: null, prev: 'cam' };
function renderClips() {
  const ul = $('st-clips'); ul.replaceChildren();
  media.items.forEach((f, i) => {
    const li = document.createElement('li'); const d = document.createElement('div'); d.className = 'grow'; d.textContent = f.name;
    const b = document.createElement('button'); b.className = i === media.i && media.el ? '' : 'ghost'; b.textContent = i === media.i && media.el ? 'Playing' : 'Play';
    b.addEventListener('click', () => { media.i = i; showMedia(); });
    li.append(d, b); ul.append(li);
  });
}
function showMedia() {
  const f = media.items[media.i];
  if (media.el?.pause) media.el.pause();
  removeAudio('media'); media.el = null;
  if (!f) { $('st-media-name').textContent = ''; renderClips(); return; }
  if (st.scene !== 'media') media.prev = st.scene;
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('video/')) {
    const v = document.createElement('video'); v.src = url; v.loop = $('st-media-loop').checked; v.playsInline = true; v.play().catch(() => {});
    v.addEventListener('ended', () => { if (!v.loop && st.scene === 'media') setScene(media.prev || 'cam'); renderClips(); });
    try { ensureAudio(); st.audioCtx.resume(); addNode(st.audioCtx.createMediaElementSource(v), 'media'); } catch { /* ignore */ }
    media.el = v;
  } else { const img = new Image(); img.src = url; media.el = img; }
  $('st-media-name').textContent = `${media.i + 1}/${media.items.length}  ${f.name}`;
  setScene('media'); renderClips();
}
let overlayImg = null; let stickerImg = null;
// ---- background music ----
const music = { items: [], i: 0, el: null };
function renderMusic() {
  const ul = $('st-music-list'); ul.replaceChildren();
  music.items.forEach((f, i) => {
    const li = document.createElement('li'); const d = document.createElement('div'); d.className = 'grow'; d.textContent = f.name;
    const b = document.createElement('button'); b.className = i === music.i && music.el && !music.el.paused ? '' : 'ghost'; b.textContent = i === music.i && music.el && !music.el.paused ? 'Playing' : 'Play';
    b.addEventListener('click', () => { music.i = i; playMusic(); });
    li.append(d, b); ul.append(li);
  });
}
function playMusic() {
  const f = music.items[music.i]; if (!f) return;
  music.el?.pause(); removeAudio('music');
  const a = new Audio(URL.createObjectURL(f)); a.loop = music.items.length === 1;
  a.addEventListener('ended', () => { music.i = (music.i + 1) % music.items.length; playMusic(); });
  try { ensureAudio(); st.audioCtx.resume(); addNode(st.audioCtx.createMediaElementSource(a), 'music'); st.gains.get('music').gain.value = 0.35; st.gains.get('music').userVolume = 0.35; renderMixer(); } catch { /* ignore */ }
  a.play().catch(() => {}); music.el = a; renderMusic();
}
// ---- saved scenes (stored in this browser) ----
const SCENE_FIELDS = ['st-lower', 'st-ticker', 'st-standby', 'st-theme', 'st-font', 'st-filter', 'st-timer', 'st-bg', 'st-bg-color', 'st-bright', 'st-contrast', 'st-sat', 'st-red', 'st-green', 'st-blue', 'st-temp', 'st-tint', 'st-hue', 'st-sharp', 'st-vig', 'st-zoom', 'st-panx', 'st-pany', 'st-rot', 'st-opacity', 'st-radius', 'st-fit', 'st-crop-l', 'st-crop-r', 'st-crop-t', 'st-crop-b', 'st-text', 'st-text-size', 'st-text-color'];
const SCENE_CHECKS = ['st-mirror', 'st-touch', 'st-flipv'];
const loadSaved = () => { try { return JSON.parse(localStorage.getItem('vs_scenes') || '[]'); } catch { return []; } };
function renderSaved() {
  const ul = $('st-saved'); ul.replaceChildren();
  loadSaved().forEach((sc, i) => {
    const li = document.createElement('li'); const d = document.createElement('div'); d.className = 'grow'; d.textContent = sc.name;
    const ap = document.createElement('button'); ap.textContent = 'Apply'; ap.addEventListener('click', () => applySaved(sc));
    const rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'x';
    rm.addEventListener('click', () => { const all = loadSaved(); all.splice(i, 1); try { localStorage.setItem('vs_scenes', JSON.stringify(all)); } catch { /* ignore */ } renderSaved(); });
    li.append(d, ap, rm); ul.append(li);
  });
}
function applySaved(sc) {
  for (const id of SCENE_FIELDS) if (sc.f[id] !== undefined) { $(id).value = sc.f[id]; $(id).dispatchEvent(new Event('change')); $(id).dispatchEvent(new Event('input')); }
  for (const id of SCENE_CHECKS) if (sc.c[id] !== undefined) $(id).checked = sc.c[id];
  updateLook();
  if (sc.scene) setScene(sc.scene);
}
function saveScene() {
  const name = (window.prompt('Name this scene (look + layout + text):') || '').trim().slice(0, 40); if (!name) return;
  const f = {}; const c = {}; for (const id of SCENE_FIELDS) f[id] = $(id).value; for (const id of SCENE_CHECKS) c[id] = $(id).checked;
  const all = loadSaved().filter((x) => x.name !== name); all.push({ name, scene: st.scene, f, c });
  try { localStorage.setItem('vs_scenes', JSON.stringify(all.slice(-20))); } catch { say('Could not save in this browser.'); }
  renderSaved();
}
const TEMPLATES = {
  'Business - Introduction': { scene: 'cam', f: { 'st-theme': 'base', 'st-lower': 'Your name  |  Your title', 'st-bg': 'grad3', 'st-ticker': '' } },
  'Business - Be right back': { scene: 'standby', f: { 'st-standby': 'We will be right back', 'st-bg': 'grad3' } },
  'Business - Presenter + slides': { scene: 'pip', f: { 'st-theme': 'base', 'st-lower': 'Presenter name', 'st-bg': 'grad3' } },
  'Business - Two cameras': { scene: 'cams', f: { 'st-theme': 'base' } },
  'Education - Class starts in': { scene: 'countdown', f: { 'st-standby': 'Class starts in', 'st-theme': 'round' }, timer: 5 },
  'Education - Teacher + screen': { scene: 'pip', f: { 'st-theme': 'round', 'st-lower': 'Topic of today', 'st-bg': 'grad1' } },
  'Gaming - Screen + camera': { scene: 'pip', f: { 'st-theme': 'news', 'st-filter': 'vivid', 'st-bg': 'grad1' } },
  'News - Speaker with ticker': { scene: 'speaker', f: { 'st-theme': 'news', 'st-ticker': 'Breaking news: write your headline here', 'st-lower': 'Reporter name' } },
  'Podcast - Side by side': { scene: 'side', f: { 'st-theme': 'round', 'st-bg': 'grad4' } },
  'Interview - Host + guests': { scene: 'grid', f: { 'st-theme': 'air', 'st-bg': 'grad3' } },
  'Vertical - Shorts speaker': { scene: 'cam', orient: 'portrait', f: { 'st-theme': 'round', 'st-lower': 'Your name', 'st-bg': 'grad2' } },
  'Vertical - Two people': { scene: 'grid', orient: 'portrait', f: { 'st-theme': 'round', 'st-bg': 'grad4' } },
  'Landscape - Standard': { scene: 'cam', orient: 'landscape', f: { 'st-theme': 'air' } },
};
function applyTemplate() {
  const t = TEMPLATES[$('st-template').value]; if (!t) return;
  if (t.orient) { $('st-orient').value = t.orient; setOrientation(t.orient === 'portrait'); }
  applySaved({ scene: t.scene, f: t.f, c: {} });
  if (t.timer) { st.timerEnd = Date.now() + t.timer * 60000; }
  say(`Template applied: ${$('st-template').value}`);
}
let teleTimer = null;
const pen = { on: false, strokes: [], cur: null };
let chatMsg = null;

// ---- layout the user can drag on the preview ----
const makeLayout = () => ({ pip: { x: W - 344, y: H - 204, w: 320 }, lower: { x: 40, y: H - 190 }, logo: { x: W - 200, y: 24, h: 90 }, timer: { x: 24, y: 24 }, chat: { x: 40, y: H - 280 }, text: { x: 60, y: 90 }, qr: { x: W - 300, y: 120 }, sticker: { x: 60, y: Math.round(H / 2 - 80) } });
const layout = makeLayout();
function setOrientation(portrait) {
  if (st.live || local) return say('Stop the live / recording before changing orientation.');
  W = portrait ? 720 : 1280; H = portrait ? 1280 : 720;
  const c = $('st-canvas'); c.width = W; c.height = H;
  c.style.aspectRatio = `${W} / ${H}`; c.style.maxHeight = portrait ? '70vh' : ''; c.style.width = portrait ? 'auto' : '100%'; c.style.margin = portrait ? '0 auto' : '';
  Object.assign(layout, makeLayout());
}
// ---- look: themes, fonts, filters ----
const THEMES = {
  air: { fill: 'rgba(0,0,0,.65)', text: '#fff', accent: '#ffcc00', round: 0, bar: 'rgba(180,0,0,.9)', barText: '#fff' },
  base: { fill: 'rgba(255,255,255,.95)', text: '#111', accent: '#2563eb', round: 0, bar: 'rgba(255,255,255,.95)', barText: '#111' },
  news: { fill: '#c1121f', text: '#fff', accent: '#fff', round: 0, bar: '#c1121f', barText: '#fff' },
  round: { fill: 'rgba(0,0,0,.8)', text: '#fff', accent: '#22d3ee', round: 30, bar: 'rgba(0,0,0,.8)', barText: '#fff' },
};
const theme = () => THEMES[$('st-theme').value] || THEMES.air;
const fnt = (n) => `bold ${n}px ${$('st-font').value || 'sans-serif'}`;
function plate(ctx, x, y, w, h, fill, round) {
  ctx.fillStyle = fill;
  if (round && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, round); ctx.fill(); } else ctx.fillRect(x, y, w, h);
}
const FILTERS = { none: '', bw: 'grayscale(1)', sepia: 'sepia(.85)', warm: 'sepia(.35) saturate(1.3) hue-rotate(-10deg)', cool: 'saturate(1.1) hue-rotate(15deg) brightness(1.03)', vivid: 'saturate(1.7) contrast(1.1)', purple: 'hue-rotate(250deg) saturate(1.4)' };
let hits = []; let drag = null;
const toCanvas = (e) => { const r = $('st-canvas').getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
const hitAt = (x, y) => [...hits].reverse().find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
const look = { filter: '', zoom: 1, px: 0, py: 0, rot: 0, flipV: false, vig: 0, op: 1, rad: 0, fit: 'fill', cl: 0, cr: 0, ct: 0, cb: 0 };
function updateLook() {
  const v = (id) => Number($(id).value);
  const r = v('st-red') / 100; const g = v('st-green') / 100; const b = v('st-blue') / 100; const temp = v('st-temp') / 100; const tint = v('st-tint') / 100;
  const R = Math.max(0, r * (1 + temp * 0.35)); const G = Math.max(0, g * (1 - tint * 0.25)); const B = Math.max(0, b * (1 - temp * 0.35));
  $('vs-cm-m').setAttribute('values', `${R} 0 0 0 0  0 ${G} 0 0 0  0 0 ${B} 0 0  0 0 0 1 0`);
  const a = (v('st-sharp') / 100) * 1.2;
  $('vs-sh-m').setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`);
  const parts = [];
  if (v('st-bright') !== 100 || v('st-contrast') !== 100 || v('st-sat') !== 100) parts.push(`brightness(${v('st-bright')}%) contrast(${v('st-contrast')}%) saturate(${v('st-sat')}%)`);
  if (v('st-hue')) parts.push(`hue-rotate(${v('st-hue')}deg)`);
  if (FILTERS[$('st-filter').value]) parts.push(FILTERS[$('st-filter').value]);
  if ($('st-touch').checked) parts.push('blur(0.9px) brightness(1.06) saturate(1.05)');
  if (R !== 1 || G !== 1 || B !== 1) parts.push('url(#vs-cm)');
  if (a > 0) parts.push('url(#vs-sh)');
  look.filter = parts.join(' ');
  look.zoom = v('st-zoom') / 100; look.px = v('st-panx') / 100; look.py = v('st-pany') / 100;
  look.rot = (Number($('st-rot').value) * Math.PI) / 180; look.flipV = $('st-flipv').checked; look.vig = v('st-vig') / 100;
  look.op = v('st-opacity') / 100; look.rad = v('st-radius') / 100; look.fit = $('st-fit').value;
  look.cl = v('st-crop-l') / 100; look.cr = v('st-crop-r') / 100; look.ct = v('st-crop-t') / 100; look.cb = v('st-crop-b') / 100;
}
function drawCamera(ctx, v, x, y, w, h) {
  ctx.save();
  if (look.filter) ctx.filter = look.filter;
  ctx.globalAlpha = look.op;
  {
    const cx = x + w * look.cl; const cy = y + h * look.ct; const cw = w * (1 - look.cl - look.cr); const ch = h * (1 - look.ct - look.cb);
    ctx.beginPath();
    if (look.rad > 0 && ctx.roundRect) ctx.roundRect(cx, cy, cw, ch, look.rad * Math.min(cw, ch) / 2); else ctx.rect(cx, cy, cw, ch);
    ctx.clip();
  }
  ctx.translate(x + w / 2, y + h / 2);
  ctx.translate(look.px * ((look.zoom - 1) * w) / 2, look.py * ((look.zoom - 1) * h) / 2);
  if (look.rot) ctx.rotate(look.rot);
  ctx.scale(look.zoom * ($('st-mirror').checked ? -1 : 1), look.zoom * (look.flipV ? -1 : 1));
  const swap = Math.round(look.rot / (Math.PI / 2)) % 2 !== 0;
  const dw = swap ? h : w; const dh = swap ? w : h;
  const src = keyed(v);
  if (look.fit === 'fit') contain(ctx, src, dw, dh, -dw / 2, -dh / 2); else if (look.fit === 'stretch') ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh); else cover(ctx, src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  if (look.vig > 0) {
    const g = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.25, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${look.vig})`);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.restore();
  }
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
const GRADS = { grad1: ['#1d2b64', '#6a3093'], grad2: ['#ff7e5f', '#feb47b'], grad3: ['#0f2027', '#2c5364'], grad4: ['#11998e', '#38ef7d'] };
function drawBackground(ctx) {
  if (GRADS[bg.mode]) { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, GRADS[bg.mode][0]); g.addColorStop(1, GRADS[bg.mode][1]); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  else if (bg.mode === 'color') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
  else if (bg.mode === 'image' && bg.img) cover(ctx, bg.img, 0, 0, W, H);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
}

function drawTile(ctx, t, x, y, w, h, speaking) {
  if (t.host) drawCamera(ctx, t.v, x, y, w, h); else cover(ctx, t.v, x, y, w, h);
  if (t.n) { ctx.font = 'bold 26px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 10, y + h - 50, ctx.measureText(t.n).width + 24, 38); ctx.fillStyle = '#fff'; ctx.fillText(t.n, x + 22, y + h - 22); }
  if (speaking) { ctx.strokeStyle = '#34d399'; ctx.lineWidth = 6; ctx.strokeRect(x + 3, y + 3, w - 6, h - 6); }
}
function drawGrid(ctx, tiles, emptyText) {
  if (!tiles.length) { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.font = '32px sans-serif'; ctx.fillText(emptyText, W / 2, H / 2); ctx.textAlign = 'left'; return; }
  const cols = Math.ceil(Math.sqrt(tiles.length)); const rows = Math.ceil(tiles.length / cols);
  const tw = W / cols; const th = H / rows;
  tiles.forEach((t, i) => drawTile(ctx, t, (i % cols) * tw + 2, Math.floor(i / cols) * th + 2, tw - 4, th - 4, false));
}
function people() {
  const out = []; const me = mainCam(); if (me) out.push({ key: 'cam', v: me, n: '', host: true });
  for (const [id, g] of guests) if (g.video && g.video.videoWidth) out.push({ key: `g${id}`, v: g.video, n: g.name });
  return out;
}
function pickSpeaker(list, now) {
  const mode = $('st-spk').value;
  if (mode !== 'auto' && list.some((p) => p.key === mode)) return mode;
  let best = null; let bl = 0;
  for (const p of list) { const l = st.levels.get(p.key) || 0; if (l > bl) { bl = l; best = p.key; } }
  if (best && bl > 0.04 && best !== st.spk && now - st.spkAt > 1200) { st.spk = best; st.spkAt = now; }
  if (!list.some((p) => p.key === st.spk)) { st.spk = list[0]?.key || ''; st.spkAt = now; }
  return st.spk;
}
function drawSpeaker(ctx, now) {
  const list = people();
  if (!list.length) return drawGrid(ctx, [], 'Turn on camera or wait for guests');
  const key = pickSpeaker(list, now);
  const big = list.find((p) => p.key === key) || list[0]; const others = list.filter((p) => p !== big);
  const strip = others.length ? 300 : 0; const bw = W - strip;
  drawTile(ctx, big, 0, 0, bw, H, others.length > 0 && (st.levels.get(big.key) || 0) > 0.04);
  const th = Math.min(169, Math.floor(H / Math.max(1, others.length)) - 6);
  others.forEach((p, i) => drawTile(ctx, p, bw + 6, i * (th + 6) + 3, strip - 9, th, (st.levels.get(p.key) || 0) > 0.04));
}
const qr = { text: '', m: null, warned: '' };
function drawQr(ctx) {
  const text = $('st-qr').value.trim(); if (!text) return;
  if (qr.text !== text) { qr.text = text; try { qr.m = qrMatrix(text); } catch { qr.m = null; } }
  if (!qr.m) { if (qr.warned !== text) { qr.warned = text; say('Link is too long for the QR code (about 170 characters at most).'); } return; }
  const n = qr.m.length; const cell = Math.max(2, Math.floor(Number($('st-qr-size').value) / (n + 8))); const box = cell * (n + 8);
  const cap = $('st-qr-label').value.trim(); const capH = cap ? 46 : 0; const { x, y } = layout.qr;
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, box, box + capH);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.m[r][c]) ctx.fillRect(x + (c + 4) * cell, y + (r + 4) * cell, cell, cell);
  if (cap) { ctx.font = fnt(26); ctx.textAlign = 'center'; ctx.fillStyle = '#000'; ctx.fillText(cap, x + box / 2, y + box + 32, box - 12); ctx.textAlign = 'left'; }
  hits.push({ id: 'qr', x, y, w: box, h: box + capH });
}
function drawSide(ctx, main) {
  const gs = [...guests.values()].find((g) => g.video && g.video.videoWidth);
  const first = st.screenVideo ? { v: st.screenVideo, fit: true } : media.el ? { v: media.el, fit: true } : gs ? { v: gs.video } : st.extras[0] ? { v: st.extras[0].video, cam: true } : null;
  const port = H > W;
  const a = port ? [0, 0, W, H / 2 - 2] : [0, 0, W / 2 - 2, H]; const b = port ? [0, H / 2 + 2, W, H / 2 - 2] : [W / 2 + 2, 0, W / 2 - 2, H];
  if (first) { if (first.fit) contain(ctx, first.v, a[2], a[3], a[0], a[1]); else if (first.cam) drawCamera(ctx, first.v, ...a); else cover(ctx, first.v, ...a); }
  else { ctx.fillStyle = '#222'; ctx.fillRect(...a); ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.font = fnt(28); ctx.fillText('Share screen, play a clip or wait for a guest', a[0] + a[2] / 2, a[1] + a[3] / 2, a[2] - 40); ctx.textAlign = 'left'; }
  if (main) drawCamera(ctx, main, ...b);
}
function drawCountdown(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#4c1d95'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const left = st.timerEnd ? Math.max(0, Math.ceil((st.timerEnd - Date.now()) / 1000)) : -1;
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.font = fnt(Math.round(W / 22)); ctx.fillText($('st-standby').value || 'Starting soon', W / 2, H / 2 - H * 0.12, W - 80);
  ctx.font = fnt(Math.round(W / 6)); ctx.fillText(left < 0 ? '--:--' : `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`, W / 2, H / 2 + H * 0.12, W - 80);
  ctx.textAlign = 'left';
  if (left === 0 && st.timerEnd && $('st-timer-auto').checked) { st.timerEnd = 0; setScene('cam'); }
}
// ---- live captions (browser speech recognition) ----
const cap = { rec: null, text: '', at: 0, log: [], t0: 0 };
function startCaptions() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('st-cap').checked = false; return say('Captions need Chrome or Edge.'); }
  const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = $('st-cap-lang').value;
  r.onresult = (e) => {
    let t = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      t += e.results[i][0].transcript;
      if (e.results[i].isFinal) { const txt = e.results[i][0].transcript.trim(); if (txt) { if (!cap.t0) cap.t0 = Date.now(); cap.log.push({ at: Date.now(), text: txt }); if (cap.log.length > 5000) cap.log.shift(); } }
    }
    cap.text = t.trim(); cap.at = Date.now();
  };
  r.onend = () => { if ($('st-cap').checked) { try { r.start(); } catch { /* ignore */ } } };
  r.onerror = (e) => { if (e.error === 'not-allowed') { $('st-cap').checked = false; say('Allow the microphone for captions.'); } };
  try { r.start(); cap.rec = r; } catch { /* ignore */ }
}
function srtTime(ms) { const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; }
function downloadTranscript(kind) {
  if (!cap.log.length) return say('No captions yet. Turn on Live captions and speak first.');
  const t0 = cap.log[0].at - 3000;
  const out = kind === 'srt'
    ? cap.log.map((l, i) => `${i + 1}\n${srtTime(Math.max(0, i ? cap.log[i - 1].at - t0 : 0))} --> ${srtTime(l.at - t0)}\n${l.text}\n`).join('\n')
    : cap.log.map((l) => l.text).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain;charset=utf-8' }));
  a.download = `transcript-${new Date().toISOString().slice(0, 10)}.${kind === 'srt' ? 'srt' : 'txt'}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function stopCaptions() { const r = cap.rec; cap.rec = null; try { r?.stop(); } catch { /* ignore */ } cap.text = ''; }
function wrapText(ctx, text, maxW) {
  const lines = []; let line = '';
  for (const w of text.split(/\s+/)) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line); return lines.slice(-2);
}
function draw(now) {
  const c = $('st-canvas'); const ctx = c.getContext('2d');
  hits = [];
  drawBackground(ctx);
  const scene = st.scene;
  const main = mainCam();
  if (scene === 'cam' && main) drawCamera(ctx, main, 0, 0, W, H);
  else if (scene === 'media' && media.el) {
    contain(ctx, media.el, W, H);
    if ($('st-media-cam').checked && main) drawPip(ctx, main);
  } else if (scene === 'screen' && st.screenVideo) contain(ctx, st.screenVideo, W, H);
  else if (scene === 'pip' && st.screenVideo) {
    contain(ctx, st.screenVideo, W, H);
    if (main) drawPip(ctx, main);
  } else if (scene === 'speaker') drawSpeaker(ctx, now);
  else if (scene === 'side') drawSide(ctx, main);
  else if (scene === 'countdown') drawCountdown(ctx);
  else if (scene === 'cams') {
    const all = [st.camVideo, ...st.extras.map((x) => x.video)].filter((v) => v && v.videoWidth);
    drawGrid(ctx, all.map((v) => ({ v, n: '', host: v === st.camVideo })), 'No cameras yet');
  } else if (scene === 'guest' || scene === 'grid') {
    const gs = [...guests.values()].filter((g) => g.video && g.video.videoWidth);
    if (scene === 'guest' && gs.length) {
      cover(ctx, gs[0].video, 0, 0, W, H);
      if (main) drawPip(ctx, main);
    } else drawGrid(ctx, [main && { v: main, n: '', host: true }, ...gs.map((g) => ({ v: g.video, n: g.name }))].filter(Boolean), 'Waiting for guests…');
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
  // overlays (not on standby / countdown, which have their own text)
  const bare = scene === 'standby' || scene === 'countdown';
  const th = theme();
  if (overlayImg && $('st-overlay-on').checked && !bare) ctx.drawImage(overlayImg, 0, 0, W, H);
  const txt = $('st-text').value.trim();
  if (txt && !bare) {
    const size = Number($('st-text-size').value); ctx.font = fnt(size); const { x, y } = layout.text;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8; ctx.fillStyle = $('st-text-color').value; ctx.fillText(txt, x, y + size, W - x - 20); ctx.restore();
    hits.push({ id: 'text', x, y, w: Math.min(ctx.measureText(txt).width, W - x - 20), h: Math.round(size * 1.25) });
  }
  if (stickerImg && !bare) {
    const h = Number($('st-sticker-size').value); const w = Math.round(stickerImg.width * (h / stickerImg.height)); const { x, y } = layout.sticker;
    ctx.drawImage(stickerImg, x, y, w, h); hits.push({ id: 'sticker', x, y, w, h });
  }
  if (!bare) drawQr(ctx);
  if (st.logo && !bare) {
    const { x, y, h } = layout.logo; const w = st.logo.width * (h / st.logo.height);
    ctx.drawImage(st.logo, x, y, w, h); hits.push({ id: 'logo', x, y, w, h });
  }
  const lower = $('st-lower').value.trim();
  if (lower && !bare) {
    const { x, y } = layout.lower;
    ctx.font = fnt(38); const tw = Math.min(ctx.measureText(lower).width + 48, W - 80);
    plate(ctx, x, y, tw, 64, th.fill, th.round);
    if (!th.round) { ctx.fillStyle = th.accent; ctx.fillRect(x, y, 8, 64); }
    ctx.fillStyle = th.text; ctx.fillText(lower, x + 24, y + 46, tw - 40);
    hits.push({ id: 'lower', x, y, w: tw, h: 64 });
  }
  const tm = $('st-timer').value;
  if (tm !== 'none' && !bare) {
    let txt; let late = false;
    if (tm === 'clock') txt = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    else if (!st.timerEnd) txt = '--:--';
    else { const left = Math.max(0, Math.ceil((st.timerEnd - Date.now()) / 1000)); late = left === 0; txt = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; }
    ctx.font = fnt(54); const w = ctx.measureText(txt).width + 40; const { x, y } = layout.timer;
    plate(ctx, x, y, w, 76, late ? 'rgba(180,0,0,.85)' : th.fill, th.round);
    ctx.fillStyle = late ? '#fff' : th.text; ctx.fillText(txt, x + 20, y + 56); hits.push({ id: 'timer', x, y, w, h: 76 });
  }
  if (chatMsg && chatMsg.until > Date.now() && !bare) {
    const { x, y } = layout.chat; ctx.font = fnt(30);
    const line = `${chatMsg.author}: ${chatMsg.text}`; const w = Math.min(ctx.measureText(line).width + 48, W - 80);
    plate(ctx, x, y, w, 56, th.fill, th.round);
    ctx.fillStyle = th.text; ctx.fillText(line, x + 24, y + 38, w - 40); hits.push({ id: 'chat', x, y, w, h: 56 });
  }
  for (const stroke of pen.strokes) {
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    stroke.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); if (stroke.pts.length === 1) ctx.lineTo(stroke.pts[0][0] + 0.1, stroke.pts[0][1]); ctx.stroke();
  }
  const tick = $('st-ticker').value.trim();
  const barH = tick && !bare ? 56 : 0;
  if (cap.text && Date.now() - cap.at < 4500 && !bare) {
    ctx.font = fnt(Math.round(W / 36)); const lines = wrapText(ctx, cap.text, W - 120); const lh = Math.round(W / 36) + 12;
    lines.forEach((ln, i) => {
      const w = ctx.measureText(ln).width + 32; const y = H - barH - 20 - (lines.length - i) * lh;
      ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect((W - w) / 2, y, w, lh); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(ln, W / 2, y + lh - 12); ctx.textAlign = 'left';
    });
  }
  if (tick && !bare) {
    plate(ctx, 0, H - 56, W, 56, th.bar, 0);
    ctx.font = fnt(30); ctx.fillStyle = th.barText;
    const tw = ctx.measureText(tick).width + 200; const x = W - ((now / 12) % (tw + W));
    ctx.fillText(tick, x, H - 16);
  }
  st.frames += 1;
  requestAnimationFrame(draw);
}

// ---- guests (WebRTC to the host's browser; the server only relays signalling) ----
function renderGuests() {
  const sel = $('st-spk'); const cur = sel.value; sel.replaceChildren();
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  add('auto', 'Auto (whoever speaks)'); add('cam', 'Me'); for (const [id, g] of guests) add(`g${id}`, g.name);
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'auto';
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

let savedDests = null;
try { const v = JSON.parse(localStorage.getItem('vs_dests') || 'null'); if (Array.isArray(v) && v.length) savedDests = new Set(v.map(String)); } catch { /* ignore */ }
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
    i.type = 'checkbox'; i.value = d.id; i.checked = prev.size ? prev.has(String(d.id)) : (savedDests ? savedDests.has(String(d.id)) : true); i.dataset.dest = d.id;
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
  try { localStorage.setItem('vs_dests', JSON.stringify(ids)); savedDests = new Set(ids.map(String)); } catch { /* ignore */ }
  ensureAudio(); st.audioCtx.resume();
  const hasAudio = st.mixed.size > 0;
  const height = Number($('st-quality').value);
  const stream = $('st-canvas').captureStream(30);
  if (hasAudio) st.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/studio/ws`);
  ws.binaryType = 'arraybuffer'; st.ws = ws;
  badge('Connecting…', 'warn'); $('st-start').disabled = true;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', audio: hasAudio, height, portrait: H > W, dest_ids: ids }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ready') {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: { 480: 1_500_000, 720: 3_000_000, 1080: 5_000_000 }[height], audioBitsPerSecond: 128_000 });
      rec.ondataavailable = (e) => {
        if (!e.data.size || ws.readyState !== 1) return;
        st.sent += e.data.size;
        if (ws.bufferedAmount > 3 * 1024 * 1024) { st.slowSince = st.slowSince || Date.now(); if (Date.now() - st.slowSince > 10000) lowerQuality(); } else st.slowSince = 0;
        e.data.arrayBuffer().then((b) => ws.readyState === 1 && ws.send(b));
      };
      rec.start(1000); st.rec = rec; st.live = true; st.t0 = Date.now(); st.sent = 0; st.retries = 0;
      badge('LIVE', 'ok'); say('Streaming. Check YouTube Studio / Facebook in a few seconds.');
      $('st-stop').classList.remove('hidden'); $('st-golive-open').classList.add('hidden'); $('st-start').disabled = false; $('dlg-golive').close();
    } else if (m.type === 'error') { say(m.message); } else if (m.type === 'ended') { cleanup(m.reason); }
  };
  ws.onclose = () => cleanup(st.live ? 'Connection lost' : '');
  ws.onerror = () => say('Could not connect to the server.');
}
// Network guard: if the upload stays backed up for 10 s, restart one quality step lower (a short blip, but no more freezing).
function lowerQuality() {
  st.slowSince = 0;
  const sel = $('st-quality'); const steps = [1080, 720, 480]; const i = steps.indexOf(Number(sel.value));
  if (i < 0 || i >= steps.length - 1 || !st.live || st.guarding) return say('Your internet is too slow. Turn off a camera or share less, or ask for a better connection.');
  st.guarding = true; sel.value = String(steps[i + 1]);
  toast(`Slow internet: switching to ${steps[i + 1]}p`);
  try { st.ws?.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
  st.retries = 0;
  setTimeout(() => { cleanup(''); setTimeout(() => { st.guarding = false; if (!st.live) goLive(); }, 2500); }, 400);
}
function cleanup(reason) {
  const lost = st.live && reason === 'Connection lost' && !st.guarding;
  try { if (st.rec && st.rec.state !== 'inactive') st.rec.stop(); } catch { /* ignore */ }
  st.rec = null; st.live = false;
  badge('Off'); if (reason) say(reason);
  $('st-stop').classList.add('hidden'); $('st-golive-open').classList.remove('hidden'); $('st-start').disabled = false;
  try { st.ws?.close(); } catch { /* ignore */ }
  st.ws = null;
  if (lost && st.retries < 3 && (st.cam || st.screen)) {
    st.retries += 1; toast(`Connection lost. Reconnecting (${st.retries}/3)...`);
    setTimeout(() => { if (!st.live && !st.ws) goLive(); }, 3000);
  }
}
function stopLive() {
  if (st.peak > 0) { fetch('/api/live-summary', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid' }, body: JSON.stringify({ peak: st.peak }) }).catch(() => {}); }
  st.peak = 0;
  try { st.ws?.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ } setTimeout(() => cleanup('Stopped'), 500); }

// ---- unified live chat (YouTube through your connected channel, Twitch read-only) ----
const chat = { items: [], tw: null, ytId: null, ytRun: 0 };
const blocked = (text) => {
  const t = String(text).toLowerCase();
  if ($('chat-links').checked && /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|xyz|ru|me|io|co)\b/.test(t)) return true;
  return $('chat-block').value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).some((w) => t.includes(w));
};
// Auto-show: new messages take turns on screen for 8 seconds each.
const showQueue = [];
setInterval(() => {
  if (!$('chat-auto').checked || !showQueue.length || (chatMsg && chatMsg.until > Date.now())) return;
  const m = showQueue.shift(); chatMsg = { author: m.author, text: m.text, until: Date.now() + 8000 };
}, 500);
let chatTotal = 0;
function addChat(src, author, text) {
  if (blocked(`${author} ${text}`)) return;
  chatTotal += 1; $('chat-count').textContent = `${chatTotal} messages`;
  if ($('chat-auto').checked && showQueue.length < 10) showQueue.push({ author, text });
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
    const ls = $('live-conn'); ls.replaceChildren();
    for (const c of connections.filter((x) => x.provider === 'google' || x.provider === 'twitch')) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.provider === 'google' ? 'YouTube' : 'Twitch'}: ${c.account_name}`; ls.append(o); }
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
  $('st-media-files').addEventListener('change', (e) => { media.items = [...e.target.files]; media.i = 0; renderClips(); });
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
    else if (e.key.toLowerCase() === 'c') $('st-clear').click();
    else if (e.key.toLowerCase() === 's') $('st-snap').click();
    else if (e.key.toLowerCase() === 'm') toggleMic();
  });
  $('st-orient').addEventListener('change', (e) => { setOrientation(e.target.value === 'portrait'); if (st.live || local) e.target.value = H > W ? 'portrait' : 'landscape'; });
  $('st-music-files').addEventListener('change', (e) => { music.items = [...e.target.files]; music.i = 0; renderMusic(); if (music.items.length) playMusic(); });
  $('st-music-pause').addEventListener('click', () => { if (!music.el) return; if (music.el.paused) music.el.play(); else music.el.pause(); renderMusic(); });
  $('st-music-next').addEventListener('click', () => { if (music.items.length) { music.i = (music.i + 1) % music.items.length; playMusic(); } });
  $('st-overlay-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const img = new Image(); img.onload = () => { overlayImg = img; $('st-overlay-on').checked = true; }; img.src = URL.createObjectURL(f); });
  $('st-cap').addEventListener('change', (e) => { if (e.target.checked) startCaptions(); else stopCaptions(); });
  $('st-cap-lang').addEventListener('change', () => { if ($('st-cap').checked) { stopCaptions(); startCaptions(); } });
  $('st-savescene').addEventListener('click', saveScene); renderSaved();
  for (const k of Object.keys(TEMPLATES)) { const o = document.createElement('option'); o.value = k; o.textContent = k; $('st-template').append(o); }
  $('st-template-apply').addEventListener('click', applyTemplate);
  try { $('st-notes').value = localStorage.getItem('vs_notes') || ''; } catch { /* ignore */ }
  $('st-notes').addEventListener('input', () => { try { localStorage.setItem('vs_notes', $('st-notes').value); } catch { /* ignore */ } });
  $('st-tele').addEventListener('change', (e) => {
    clearInterval(teleTimer); if (!e.target.checked) return;
    teleTimer = setInterval(() => { const n = $('st-notes'); n.scrollTop += Number($('st-tele-speed').value) / 10; }, 50);
  });
  for (const ev of ['input', 'change']) $('studio-card').addEventListener(ev, updateLook);
  updateLook();
  $('st-color-reset').addEventListener('click', () => {
    for (const id of ['st-red', 'st-green', 'st-blue', 'st-temp', 'st-tint', 'st-hue', 'st-sharp', 'st-vig', 'st-zoom', 'st-panx', 'st-pany', 'st-bright', 'st-contrast', 'st-sat', 'st-opacity', 'st-radius', 'st-crop-l', 'st-crop-r', 'st-crop-t', 'st-crop-b']) $(id).value = $(id).defaultValue;
    $('st-fit').value = 'fill';
    $('st-rot').value = '0'; $('st-filter').value = 'none'; $('st-flipv').checked = false; $('st-touch').checked = false; $('st-mirror').checked = false; updateLook();
  });
  $('st-adelay').addEventListener('input', (e) => { if (st.camDelay) st.camDelay.delayTime.value = Number(e.target.value) / 1000; });
  $('st-freeze').addEventListener('click', () => {
    const v = mainCam(); if (!v) return; if (v.paused) { v.play(); $('st-freeze').textContent = 'Freeze camera'; } else { v.pause(); $('st-freeze').textContent = 'Unfreeze camera'; }
  });
  $('st-sticker-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const img = new Image(); img.onload = () => { stickerImg = img; }; img.src = URL.createObjectURL(f); });
  $('st-mute').addEventListener('click', toggleMic);
  try { const q = localStorage.getItem('vs_quality'); if (q) $('st-quality').value = q; } catch { /* ignore */ }
  $('st-quality').addEventListener('change', () => { try { localStorage.setItem('vs_quality', $('st-quality').value); } catch { /* ignore */ } });
  let lastFrames = 0;
  setInterval(() => {
    const fps = st.frames - lastFrames; lastFrames = st.frames;
    const secs = st.live ? Math.round((Date.now() - st.t0) / 1000) : 0;
    const buf = st.ws ? Math.round(st.ws.bufferedAmount / 1024) : 0;
    const mb = (st.sent / 1048576).toFixed(1); const kbps = secs ? Math.round((st.sent * 8) / 1000 / secs) : 0;
    const hms = `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    const health = !st.live ? 'Not live' : buf > 4096 ? 'Slow internet: lower the quality' : buf > 1024 ? 'Slightly slow' : 'Good';
    const rows = [['Status', st.live ? 'LIVE' : 'Off'], ['Live time', hms], ['Sent', `${mb} MB`], ['Average bitrate', `${kbps} kbps`], ['Upload backlog', `${buf} KB`], ['Connection', health], ['Preview speed', `${fps} fps`], ['Canvas', `${W} x ${H}`], ['Guests', String(guests.size)], ...(st.viewers?.channels?.length ? [['Viewers (total)', String(st.viewers.total)], ...st.viewers.channels.map((c) => [`  ${c.provider === 'google' ? 'YouTube' : 'Twitch'}: ${c.account}`, c.error ? '?' : String(c.viewers)])] : []), ['Cameras', String((st.camVideo ? 1 : 0) + st.extras.length)], ['Microphones', String([...st.gains.keys()].filter((k) => k === 'cam' || k.startsWith('mic:')).length)]];
    const box = $('st-stats'); if (!box) return;
    box.replaceChildren(...rows.map(([k, v]) => { const li = document.createElement('li'); const a = document.createElement('span'); a.className = 'grow'; a.textContent = k; const b = document.createElement('strong'); b.textContent = v; li.append(a, b); return li; }));
  }, 1000);
  // viewers on connected YouTube / Twitch channels (only asked while live)
  st.viewers = null;
  const pollViewers = async () => {
    if (!st.live) { st.viewers = null; return; }
    try { const r = await fetch('/api/viewers', { credentials: 'same-origin', headers: { 'x-requested-with': 'vivid' } }); if (r.ok) { st.viewers = await r.json(); st.peak = Math.max(st.peak || 0, st.viewers.total || 0); } } catch { /* ignore */ }
  };
  setInterval(pollViewers, 20000);
  $('st-start').addEventListener('click', () => setTimeout(pollViewers, 8000));
  $('live-save').addEventListener('click', async () => {
    const connection = Number($('live-conn').value); const title = $('live-title').value.trim();
    if (!connection) return say('Connect a YouTube or Twitch channel first (Destinations tab).');
    if (!title) return say('Write the new title.');
    const r = await fetch('/api/live-info', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid' }, body: JSON.stringify({ connection, title, description: $('live-desc').value.trim() || undefined }) });
    const d = await r.json().catch(() => ({}));
    toast(r.ok ? 'Title updated' : (d.error || 'Could not update the title'));
  });
  $('chat-clear').addEventListener('click', () => { chat.items.length = 0; showQueue.length = 0; $('chat-list').replaceChildren(); });
  $('st-cap-srt')?.addEventListener('click', () => downloadTranscript('srt'));
  $('st-cap-txt')?.addEventListener('click', () => downloadTranscript('txt'));
  $('st-addcam').addEventListener('click', addCamera);
  $('st-addmic').addEventListener('click', addMic);
  $('st-media-loop').addEventListener('change', (e) => { if (media.el?.pause) media.el.loop = e.target.checked; });
  setInterval(updateLevels, 100);
  initChat();
  $('st-rec').addEventListener('click', toggleRecord);
  $('st-start').addEventListener('click', () => { st.retries = 0; goLive(); });
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
