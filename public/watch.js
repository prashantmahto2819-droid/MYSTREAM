const $ = (id) => document.getElementById(id);
const slug = location.pathname.split('/').pop();
const KEY = `vs_reg_${slug}`;
let ev = null; let skew = 0; let shown = false;

async function load() {
  const res = await fetch(`/api/public/event/${slug}`, { headers: { 'x-requested-with': 'vivid' } });
  if (!res.ok) { $('w-title').textContent = 'Event not found'; return; }
  ev = await res.json();
  skew = ev.now - Date.now();
  document.title = ev.title;
  $('w-title').textContent = ev.title;
  $('w-desc').textContent = ev.description;
  $('w-when').textContent = `Starts ${new Date(ev.start_at).toLocaleString()}`;
  $('w-phone-row').classList.toggle('hidden', !ev.ask_phone);
  let reg = false; try { reg = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
  $('w-form').classList.toggle('hidden', reg);
  $('w-done').classList.toggle('hidden', !reg);
  tick();
}

function tick() {
  if (!ev) return;
  const left = ev.start_at - (Date.now() + skew);
  const c = $('w-count');
  if (left > 0) {
    const s = Math.floor(left / 1000); const p = (n) => String(n).padStart(2, '0');
    const d = Math.floor(s / 86400);
    c.textContent = `${d ? `${d}d ` : ''}${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    c.classList.remove('hidden');
  } else {
    c.classList.add('hidden');
  }
  // Ask the server for the player address once we are close to the start (it hides it before that).
  if (!ev.embed && left < 10 * 60000 && !shown) { shown = true; load().then(() => { shown = false; }); }
  if (ev.embed && left < 10 * 60000 && !$('w-frame').src) {
    $('w-frame').src = ev.embed;
    $('w-player').classList.remove('hidden');
  }
}
setInterval(tick, 1000);

$('w-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('w-msg').textContent = '';
  const res = await fetch(`/api/public/event/${slug}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid' },
    body: JSON.stringify({ name: f.get('name'), email: f.get('email'), phone: f.get('phone') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('w-msg').textContent = data.error || 'Could not register'; return; }
  try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
  $('w-form').classList.add('hidden'); $('w-done').classList.remove('hidden');
});
load();
