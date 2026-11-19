const $ = (id) => document.getElementById(id);
let me = null;
let presets = [];
let pollTimer = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Builds elements with textContent only (never innerHTML) so user text cannot inject markup.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'onchange') n.addEventListener('change', v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
}

function showLogin() {
  clearInterval(pollTimer);
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

async function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = `${me.name} (${me.role})`;
  $('team-card').classList.toggle('hidden', me.role !== 'admin');
  presets = (await api('GET', '/api/presets')).presets;
  const sel = $('platform');
  sel.replaceChildren(...presets.map((p) => el('option', { value: p.id }, p.label)));
  applyPreset();
  $('sched-start').value = defaultStart();
  await loadSettings();
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh().catch(() => {}), 3000);
}

function applyPreset() {
  const p = presets.find((x) => x.id === $('platform').value);
  if (p && p.url) $('rtmp-url').value = p.url;
}

const STATUS_LABEL = { idle: 'Idle', starting: 'Starting…', live: 'Live', error: 'Error' };

async function refresh() {
  const s = await api('GET', '/api/status');
  $('ingest-url').value = s.ingest.url;
  $('ingest-key').value = s.ingest.key;
  const badge = $('ingest-badge');
  badge.textContent = s.ingest.live ? 'Receiving your stream' : 'Not receiving';
  badge.className = 'badge' + (s.ingest.live ? ' live' : '');
  $('mtx-badge').classList.toggle('hidden', s.mediamtxOk !== false);

  const list = $('dest-list');
  list.replaceChildren(...s.destinations.map((d) => {
    const st = d.status;
    const info = el('div', { class: 'grow' },
      el('div', {}, d.name, me.role === 'admin' && d.user_id !== me.id ? ' (other user)' : ''),
      el('div', { class: 'sub' }, d.rtmp_url),
      d.error ? el('div', { class: 'sub err-text' }, d.error) : '',
      d.stats ? el('div', { class: 'sub' }, `${Math.round(d.stats.bitrateKbps || 0)} kbps · speed ${(d.stats.speed || 0).toFixed(2)}x`) : '');
    const toggle = el('label', { class: 'switch' },
      el('input', { type: 'checkbox', ...(d.enabled ? { checked: '' } : {}),
        onchange: async (e) => {
          try { await api('PATCH', `/api/destinations/${d.id}`, { enabled: e.target.checked }); await refresh(); }
          catch (err) { alert(err.message); await refresh(); }
        } }),
      'On');
    return el('li', {}, info,
      el('span', { class: `badge ${st}` }, d.enabled ? STATUS_LABEL[st] : 'Off'),
      toggle,
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Delete "${d.name}"?`)) return;
        try { await api('DELETE', `/api/destinations/${d.id}`); await refresh(); } catch (err) { alert(err.message); }
      } }, 'Delete'));
  }));
  $('dest-empty').classList.toggle('hidden', s.destinations.length > 0);

  const a = await api('GET', '/api/activity');
  $('activity').replaceChildren(...a.activity.slice(0, 30).map((x) =>
    el('li', {}, el('span', { class: 'sub' }, x.ts), el('span', { class: 'grow' }, `${x.user_name || 'system'} · ${x.action.replace(/_/g, ' ')}${x.detail ? ' — ' + x.detail : ''}`))));

  await Promise.all([refreshVideos(), refreshSchedules(), refreshStorage(), refreshRecordings()]);
  renderScheduleChoices(s.destinations);
  if (me.role === 'admin') await refreshUsers();
}

// ---------- videos, upload, schedules ----------
const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : `${m}m ${sec}s`;
};
const fmtTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
let videoCache = [];
let pickedVideos = []; // ids in the order they were ticked
let uploading = false;

async function refreshStorage() {
  const s = await api('GET', '/api/storage');
  $('storage').textContent = `Your storage: ${fmtBytes(s.usedBytes)} of ${fmtBytes(s.quotaBytes)} · Server free space: ${fmtBytes(s.freeBytes)}`;
}

async function refreshVideos() {
  const { videos } = await api('GET', '/api/videos');
  videoCache = videos;
  const label = { uploading: 'Uploading', processing: 'Preparing…', ready: 'Ready', failed: 'Failed' };
  const cls = { uploading: 'starting', processing: 'starting', ready: 'live', failed: 'error' };
  $('video-list').replaceChildren(...videos.map((v) => el('li', {},
    el('div', { class: 'grow' }, v.title,
      el('div', { class: 'sub' }, [fmtBytes(v.expected_size), fmtDur(v.duration), v.width ? `${v.width}x${v.height}` : ''].filter(Boolean).join(' · ')),
      v.error ? el('div', { class: 'sub err-text' }, v.error) : ''),
    el('span', { class: `badge ${cls[v.status]}` }, label[v.status]),
    el('button', { class: 'danger', ...(v.status === 'processing' || v.in_use ? { disabled: '' } : {}),
      onclick: async () => {
        if (!confirm(`Delete "${v.title}"?`)) return;
        try { await api('DELETE', `/api/videos/${v.id}`); await refresh(); } catch (err) { alert(err.message); }
      } }, 'Delete'))));
  $('video-empty').classList.toggle('hidden', videos.length > 0);
  renderVideoChoices();
}

function renderVideoChoices() {
  const ready = videoCache.filter((v) => v.status === 'ready' && v.user_id === me.id);
  pickedVideos = pickedVideos.filter((id) => ready.some((v) => v.id === id));
  const box = $('sched-videos');
  const sig = ready.map((v) => v.id).join(',');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(...ready.map((v) => el('label', {},
      el('input', { type: 'checkbox', value: v.id, ...(pickedVideos.includes(v.id) ? { checked: '' } : {}),
        onchange: (e) => {
          pickedVideos = pickedVideos.filter((id) => id !== v.id);
          if (e.target.checked) pickedVideos.push(v.id);
          renderVideoChoices();
        } }),
      el('span', { 'data-title': v.id }, v.title))));
    if (!ready.length) box.replaceChildren(el('span', { class: 'sub' }, 'No ready videos yet.'));
  }
  box.querySelectorAll('[data-title]').forEach((sp) => {
    const v = ready.find((x) => x.id === Number(sp.dataset.title));
    const pos = pickedVideos.indexOf(v.id);
    sp.textContent = `${pos >= 0 ? `${pos + 1}. ` : ''}${v.title}${v.duration ? ` (${fmtDur(v.duration)})` : ''}`;
  });
}

function renderScheduleChoices(dests) {
  const mine = dests.filter((d) => d.user_id === me.id);
  const box = $('sched-dests');
  const sig = mine.map((d) => `${d.id}:${d.name}`).join(',');
  if (box.dataset.sig === sig) return;
  const checked = new Set([...box.querySelectorAll('input:checked')].map((i) => Number(i.value)));
  box.dataset.sig = sig;
  box.replaceChildren(...mine.map((d) => el('label', {},
    el('input', { type: 'checkbox', value: d.id, ...(checked.has(d.id) ? { checked: '' } : {}) }), d.name)));
  if (!mine.length) box.replaceChildren(el('span', { class: 'sub' }, 'Add a destination first.'));
}

async function refreshSchedules() {
  const { schedules } = await api('GET', '/api/schedules');
  const label = { scheduled: 'Scheduled', running: 'Live now', done: 'Finished', failed: 'Failed', missed: 'Missed', cancelled: 'Cancelled' };
  const cls = { scheduled: 'starting', running: 'live', done: '', failed: 'error', missed: 'error', cancelled: '' };
  $('schedule-list').replaceChildren(...schedules.map((s) => el('li', {},
    el('div', { class: 'grow' }, s.title,
      el('div', { class: 'sub' }, `${fmtTime(s.start_at)} · ${s.videos.join(', ')}${s.loop_count === 0 ? ' · repeats until stopped' : s.loop_count > 1 ? ` · ×${s.loop_count}` : ''}`),
      s.error ? el('div', { class: 'sub err-text' }, s.error) : ''),
    el('span', { class: `badge ${cls[s.status]}` }, label[s.status]),
    s.status === 'scheduled' || s.status === 'running'
      ? el('button', { class: 'danger', onclick: async () => {
        if (!confirm(s.status === 'running' ? 'Stop this live now?' : 'Cancel this schedule?')) return;
        try { await api('POST', `/api/schedules/${s.id}/cancel`); await refresh(); } catch (err) { alert(err.message); }
      } }, s.status === 'running' ? 'Stop' : 'Cancel')
      : '')));
  $('schedule-empty').classList.toggle('hidden', schedules.length > 0);
}

class FatalUploadError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends the file in chunks; after a network drop it asks the server how much it has and continues from there.
async function uploadFile(file, onProgress) {
  const { id, chunkSize } = await api('POST', '/api/uploads', { filename: file.name, size: file.size });
  let offset = 0;
  while (offset < file.size) {
    let tries = 0;
    for (;;) {
      try {
        const res = await fetch(`/api/uploads/${id}?offset=${offset}`, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'vivid' },
          body: file.slice(offset, Math.min(offset + chunkSize, file.size)),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && Number.isInteger(data.received)) { offset = data.received; break; }
        if (!res.ok) {
          if (res.status < 500) throw new FatalUploadError(data.error || `Error ${res.status}`);
          throw new Error(data.error || `Error ${res.status}`);
        }
        offset = data.received;
        break;
      } catch (e) {
        if (e instanceof FatalUploadError || (tries += 1) > 8) throw e;
        await sleep(Math.min(2000 * tries, 15000));
        try { offset = (await api('GET', `/api/uploads/${id}`)).received; } catch { /* retry */ }
      }
    }
    onProgress(offset / file.size);
  }
  await api('POST', `/api/uploads/${id}/complete`);
}

$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (uploading) return;
  const file = e.target.elements.file.files[0];
  if (!file) return;
  uploading = true;
  const bar = $('upload-progress');
  $('upload-btn').disabled = true;
  $('upload-status').textContent = 'Uploading… keep this page open.';
  bar.classList.remove('hidden'); bar.value = 0;
  try {
    await uploadFile(file, (p) => { bar.value = Math.round(p * 100); $('upload-status').textContent = `Uploading… ${Math.round(p * 100)}%`; });
    $('upload-status').textContent = 'Uploaded. The server is checking the video (long files can take a while).';
    e.target.reset();
  } catch (err) { $('upload-status').textContent = `Upload failed: ${err.message}`; }
  uploading = false;
  $('upload-btn').disabled = false;
  bar.classList.add('hidden');
  await refresh().catch(() => {});
});

function defaultStart() {
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('sched-error').textContent = '';
  const f = new FormData(e.target);
  const dest_ids = [...$('sched-dests').querySelectorAll('input:checked')].map((i) => Number(i.value));
  try {
    await api('POST', '/api/schedules', {
      title: f.get('title') || undefined, video_ids: pickedVideos, start_at: new Date(f.get('start')).getTime(),
      loop_count: Number(f.get('loops')), dest_ids, delete_after: f.get('delete_after') === 'on',
    });
    pickedVideos = [];
    $('sched-videos').dataset.sig = '';
    e.target.elements.title.value = '';
    await refresh();
  } catch (err) { $('sched-error').textContent = err.message; }
});

$('phone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('PATCH', '/api/me', { phone: $('phone').value }); $('phone-note').textContent = 'Saved.'; }
  catch (err) { $('phone-note').textContent = err.message; }
});

async function loadSettings() {
  const s = await api('GET', '/api/me/settings');
  $('phone').value = s.phone || '';
  $('phone-note').textContent = s.alertsConfigured ? '' : 'WhatsApp alerts are not set up on the server yet.';
  $('record-toggle').checked = !!s.record;
  $('record-note').textContent = `(kept ${s.recordingKeepDays} days)`;
  await refreshKeys();
}

async function refreshRecordings() {
  const { recordings } = await api('GET', '/api/recordings');
  $('rec-list').replaceChildren(...recordings.map((r) => el('li', {},
    el('div', { class: 'grow' }, r.title, el('div', { class: 'sub' }, `${fmtBytes(r.size)} · ${r.status === 'recording' ? 'recording now…' : fmtTime(r.ended_at)}`)),
    r.status === 'done' ? el('a', { href: `/api/recordings/${r.id}/download`, class: 'btnlink' }, 'Download') : '',
    r.status === 'done' ? el('button', { class: 'ghost', onclick: async () => {
      try { await api('POST', `/api/recordings/${r.id}/to-video`); await refresh(); } catch (err) { alert(err.message); }
    } }, 'Use as video') : '',
    r.status === 'done' ? el('button', { class: 'danger', onclick: async () => {
      if (!confirm('Delete this recording?')) return;
      try { await api('DELETE', `/api/recordings/${r.id}`); await refresh(); } catch (err) { alert(err.message); }
    } }, 'Delete') : '')));
  $('rec-empty').classList.toggle('hidden', recordings.length > 0);
}

async function refreshKeys() {
  const { keys } = await api('GET', '/api/keys');
  $('key-list').replaceChildren(...keys.map((k) => el('li', {},
    el('div', { class: 'grow' }, k.name, el('div', { class: 'sub' }, `${k.prefix}… · created ${k.created_at}${k.last_used_at ? ' · last used ' + fmtTime(k.last_used_at) : ''}`)),
    el('button', { class: 'danger', onclick: async () => {
      if (!confirm(`Revoke "${k.name}"? Software using it will stop working.`)) return;
      try { await api('DELETE', `/api/keys/${k.id}`); await refreshKeys(); } catch (err) { alert(err.message); }
    } }, 'Revoke'))));
}

$('record-toggle').addEventListener('change', async (e) => {
  try { await api('PATCH', '/api/me', { record: e.target.checked }); } catch (err) { alert(err.message); e.target.checked = !e.target.checked; }
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/me/password', { current: f.get('current'), new: f.get('new') });
    e.target.reset();
    $('pw-note').textContent = 'Password changed. Other devices were signed out.';
  } catch (err) { $('pw-note').textContent = err.message; }
});

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('key-error').textContent = '';
  try {
    const { token } = await api('POST', '/api/keys', { name: new FormData(e.target).get('name') });
    $('key-new-value').value = token;
    $('key-new').classList.remove('hidden');
    e.target.reset();
    await refreshKeys();
  } catch (err) { $('key-error').textContent = err.message; }
});

async function refreshUsers() {
  const { users } = await api('GET', '/api/users');
  $('user-list').replaceChildren(...users.map((u) => el('li', {},
    el('div', { class: 'grow' }, `${u.name} · ${u.role}`, el('div', { class: 'sub' }, u.email)),
    el('span', { class: `badge ${u.active ? 'live' : ''}` }, u.active ? 'Active' : 'Disabled'),
    u.id === me.id ? '' : el('button', { class: 'ghost', onclick: async () => {
      try { await api('PATCH', `/api/users/${u.id}`, { active: !u.active }); await refreshUsers(); } catch (err) { alert(err.message); }
    } }, u.active ? 'Disable' : 'Enable'))));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const f = new FormData(e.target);
  try {
    me = (await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') })).user;
    e.target.reset();
    await showApp();
  } catch (err) { $('login-error').textContent = err.message; }
});

$('logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } showLogin(); });
$('platform').addEventListener('change', applyPreset);

$('dest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('dest-error').textContent = '';
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/destinations', {
      platform: f.get('platform'), name: f.get('name'), rtmp_url: f.get('rtmp_url'), stream_key: f.get('stream_key'),
    });
    e.target.querySelector('[name=name]').value = '';
    e.target.querySelector('[name=stream_key]').value = '';
    await refresh();
  } catch (err) { $('dest-error').textContent = err.message; }
});

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('user-error').textContent = '';
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/users', Object.fromEntries(f.entries()));
    e.target.reset();
    await refreshUsers();
  } catch (err) { $('user-error').textContent = err.message; }
});

$('rotate').addEventListener('click', async () => {
  if (!confirm('The old stream key stops working. Update OBS with the new key. Continue?')) return;
  try { await api('POST', '/api/me/rotate-ingest-key'); await refresh(); } catch (err) { alert(err.message); }
});

$('toggle-key').addEventListener('click', (e) => {
  const input = $('ingest-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.target.textContent = show ? 'Hide' : 'Show';
});

document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(b.dataset.copy).value); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); }
  catch { /* clipboard blocked */ }
}));

(async () => {
  try { me = (await api('GET', '/api/me')).user; await showApp(); } catch { showLogin(); }
})();
