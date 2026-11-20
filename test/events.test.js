import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword } from '../src/crypto.js';
import { createApp } from '../src/server.js';
import { RelayManager } from '../src/relay.js';
import { parseEmbed, embedUrl, EventReminders, normalizePhone } from '../src/events.js';

async function boot() {
  const store = openDb(':memory:'); const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: hashPassword('pass12345') });
  const other = store.createUser({ email: 'b@x.com', name: 'B', passwordHash: hashPassword('pass12345') });
  const cfg = { mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m', publicRtmpUrl: 'rtmp://r', ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, maxDestinationsPerUser: 5, dataDir: '/tmp' };
  const quiet = { error() {}, warn() {}, info() {} };
  const relay = new RelayManager({ store, vault, cfg, internalToken: 'T', log: quiet, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('x'); } });
  const server = createApp({ cfg, store, relay, internalToken: 'T', processor: {}, player: {}, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); server.unref();
  const port = server.address().port;
  const call = async (method, path, { cookie, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-requested-with': 'vivid', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { store, uid, other, call, cookie: (id) => `sid=${store.createSession(id, 3600000)}` };
}

test('parseEmbed accepts only YouTube / Twitch / Facebook https links', () => {
  assert.deepEqual(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { type: 'youtube', ref: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseEmbed('https://youtu.be/dQw4w9WgXcQ'), { type: 'youtube', ref: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseEmbed('https://youtube.com/live/dQw4w9WgXcQ?feature=share'), { type: 'youtube', ref: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseEmbed('https://twitch.tv/Prashant'), { type: 'twitch', ref: 'prashant' });
  assert.equal(parseEmbed('https://evil.com/x'), null);
  assert.equal(parseEmbed('http://youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseEmbed('javascript:alert(1)'), null);
  assert.deepEqual(parseEmbed(''), { type: '', ref: '' });
  assert.match(embedUrl('twitch', 'prashant', 'live.example.com:3000'), /parent=live\.example\.com&/);
  assert.equal(embedUrl('youtube', '../x', 'h'), '');
});

test('events: create, public page, registration, csv, ownership', async () => {
  const t = await boot();
  const c = t.cookie(t.uid); const o = t.cookie(t.other);
  const soon = Date.now() + 3600_000;
  assert.equal((await t.call('POST', '/api/events', { cookie: c, body: { title: '', start_at: soon } })).status, 400);
  assert.equal((await t.call('POST', '/api/events', { cookie: c, body: { title: 'T', start_at: soon, embed_url: 'https://evil.com' } })).status, 400);
  const mk = await t.call('POST', '/api/events', { cookie: c, body: { title: 'Webinar', start_at: soon, embed_url: 'https://youtu.be/dQw4w9WgXcQ', ask_phone: true } });
  assert.equal(mk.status, 201);
  const slug = mk.json.slug;
  assert.match(mk.json.path, /^\/e\/[a-z0-9]+$/);

  const page = await t.call('GET', mk.json.path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/www\.youtube\.com/);

  const pub = await t.call('GET', `/api/public/event/${slug}`);
  assert.equal(pub.json.title, 'Webinar');
  assert.equal(pub.json.embed, ''); // hidden until 10 minutes before
  assert.equal((await t.call('GET', '/api/public/event/nope')).status, 404);

  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: '' } })).status, 400);
  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: 'Ravi' } })).status, 400);
  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: 'Ravi', phone: '12' } })).status, 400);
  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: 'Ravi', phone: '+91 98765 43210' } })).status, 201);
  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: 'Ravi again', phone: '+919876543210' } })).json.already, true);
  assert.equal((await t.call('POST', `/api/public/event/${slug}/register`, { body: { name: '=cmd()', email: 'x@y.com' } })).status, 201);

  const list = await t.call('GET', '/api/events', { cookie: c });
  assert.equal(list.json[0].regs, 2);
  assert.equal((await t.call('GET', '/api/events', { cookie: o })).json.length, 0);
  assert.equal((await t.call('GET', `/api/events/${mk.json.id}/registrations`, { cookie: o })).status, 404);
  const csv = await t.call('GET', `/api/events/${mk.json.id}/registrations.csv`, { cookie: c });
  assert.match(csv.text, /"'=cmd\(\)"/); // spreadsheet formula is neutralised
  assert.equal((await t.call('GET', '/api/events')).status, 401);

  // near the start time the player address is handed out
  t.store.updateEvent(mk.json.id, { title: 'Webinar', description: '', startAt: Date.now() + 5 * 60000, embedType: 'youtube', embedRef: 'dQw4w9WgXcQ', askPhone: 1, remindMinutes: 15 });
  assert.match((await t.call('GET', `/api/public/event/${slug}`)).json.embed, /^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ/);

  const up = await t.call('PUT', `/api/events/${mk.json.id}`, { cookie: c, body: { title: 'New', start_at: soon, embed_url: 'https://twitch.tv/abc' } });
  assert.equal(up.json.embed_type, 'twitch');
  assert.equal((await t.call('DELETE', `/api/events/${mk.json.id}`, { cookie: o })).status, 404);
  assert.equal((await t.call('DELETE', `/api/events/${mk.json.id}`, { cookie: c })).status, 200);
});

test('reminder is sent once, shortly before the start', async () => {
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  let now = 1_800_000_000_000; const sent = [];
  const id = store.createEvent({ userId: uid, slug: 'abc', title: 'Live', description: '', startAt: now + 30 * 60000, embedType: '', embedRef: '', askPhone: 0, remindMinutes: 15 });
  store.addRegistration({ eventId: id, name: 'R', email: 'r@x.com', phone: '' });
  store.addRegistration({ eventId: id, name: 'P', email: '', phone: '9876543210' });
  const direct = [];
  const r = new EventReminders({ store, notifier: { send: async (u, m) => { sent.push(m); }, sendTo: async (n, m) => { direct.push([n, m]); } }, now: () => now, baseUrl: 'https://live.x.com' });
  await r.tick(); assert.equal(sent.length, 0);
  now += 16 * 60000; await r.tick(); assert.equal(sent.length, 1); assert.match(sent[0], /Live/); assert.match(sent[0], /2/);
  assert.deepEqual(direct[0][0], ['919876543210']); assert.match(direct[0][1], /https:\/\/live\.x\.com\/e\/abc/);
  now += 60000; await r.tick(); assert.equal(sent.length, 1); assert.equal(direct.length, 1);
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210'); assert.equal(normalizePhone('12'), '');
});

test('readiness: plain-language checklist reflects the setup', async () => {
  const t = await boot();
  const c = t.cookie(t.uid);
  const r = await t.call('GET', '/api/readiness', { cookie: c });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.json.items.map((i) => [i.id, i.ok]));
  assert.equal(by.destinations, false); assert.equal(by.alerts, false); assert.equal(by.phone, false);
  assert.ok(r.json.items.every((i) => i.ok || i.fix));
  t.store.createDestination({ userId: t.uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a/b', keyEnc: 'x' });
  const r2 = await t.call('GET', '/api/readiness', { cookie: c });
  assert.equal(Object.fromEntries(r2.json.items.map((i) => [i.id, i.ok])).destinations, true);
  assert.ok(r2.json.done > r.json.done);
  assert.equal((await t.call('GET', '/api/readiness')).status, 401);
});
