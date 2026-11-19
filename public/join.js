// Guest side: send camera + mic to the host's browser over WebRTC; the server only passes signalling.
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
let ws = null; let pc = null; let media = null;
const say = (m) => { $('g-msg').textContent = m; };

async function join() {
  if (!token) return say('This invite link is incomplete.');
  try {
    media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) { return say(`Camera/mic not available: ${e.message}`); }
  $('g-preview').srcObject = media;
  $('g-join').disabled = true; say('Connecting…');
  const name = $('g-name').value.trim() || 'Guest';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/guest/join?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`);
  ws.onerror = () => { say('Could not join. The host may not have opened the studio yet, or the link expired.'); reset(); };
  ws.onclose = () => { if (pc) { say('Disconnected.'); reset(); } };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') await start();
    else if (m.type === 'signal') {
      if (m.signal.sdp) await pc.setRemoteDescription(m.signal.sdp);
      else if (m.signal.candidate) await pc.addIceCandidate(m.signal.candidate).catch(() => {});
    } else if (m.type === 'host-left') { say('The host closed the studio.'); reset(); }
    else if (m.type === 'kicked') { say('You were removed by the host.'); reset(); }
  };
}

async function start() {
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
  for (const t of media.getTracks()) pc.addTrack(t, media);
  pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ signal: { candidate: e.candidate } })); };
  pc.ontrack = (e) => { $('g-remote').srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'connected') { say('Connected. You are in the studio.'); $('g-mute').classList.remove('hidden'); $('g-leave').classList.remove('hidden'); }
    if (pc?.connectionState === 'failed') say('Connection failed. Try another network or refresh.');
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ signal: { sdp: pc.localDescription } }));
}

function reset() {
  try { pc?.close(); } catch { /* ignore */ }
  pc = null; try { ws?.close(); } catch { /* ignore */ }
  media?.getTracks().forEach((t) => t.stop()); media = null;
  $('g-join').disabled = false; $('g-mute').classList.add('hidden'); $('g-leave').classList.add('hidden');
}

$('g-join').addEventListener('click', join);
$('g-leave').addEventListener('click', () => { say('You left.'); reset(); });
$('g-mute').addEventListener('click', () => {
  const t = media?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('g-mute').textContent = t.enabled ? 'Mute mic' : 'Unmute mic';
});
