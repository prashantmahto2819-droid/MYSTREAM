import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword } from '../src/crypto.js';
import { RelayManager } from '../src/relay.js';
import { createApp } from '../src/server.js';

async function boot() {
  const cfg = {
    mediamtxApi: 'http://mtx', mediamtxRtmp: 'rtmp://mtx:1935', publicRtmpUrl: 'rtmp://rtmp.example.com/live',
    ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, maxDestinations: 3,
    maxDestinationsPerUser: 2,
  };
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const adminId = store.createUser({ email: 'admin@x.com', name: 'Admin', passwordHash: hashPassword('adminpass1'), role: 'admin' });
  const opId = store.createUser({ email: 'op@x.com', name: 'Op', passwordHash: hashPassword('operpass1'), role: 'operator' });
  const relay = new RelayManager({
    store, vault, cfg, internalToken: 'TOK-INTERNAL', fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }),
    spawn: () => { throw new Error('no spawn in api test'); }, log: { error() {}, warn() {}, info() {} },
  });
  const server = createApp({ cfg, store, relay, internalToken: 'TOK-INTERNAL', log: { error() {}, warn() {}, info() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid', cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    };
  };
  return { store, server, client, adminId, opId, close: () => new Promise((r) => server.close(r)) };
}

test('auth, csrf header, roles', async () => {
  const t = await boot();
  const anon = t.client();
  assert.equal((await anon('GET', '/api/status')).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'op@x.com', password: 'nope' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'op@x.com', password: 'operpass1' }, { 'x-requested-with': '' })).status, 403, 'csrf header required');

  const op = t.client();
  const login = await op('POST', '/api/login', { email: 'op@x.com', password: 'operpass1' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await op('GET', '/api/users')).status, 403, 'operator cannot list users');
  assert.equal((await op('POST', '/api/users', { email: 'z@x.com', name: 'Z', password: 'password1' })).status, 403);
  const st = await op('GET', '/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.ingest.url, 'rtmp://rtmp.example.com/live');
  assert.match(st.json.ingest.key, /^[0-9a-f]{24}$/);
  await op('POST', '/api/logout');
  assert.equal((await op('GET', '/api/me')).status, 401);
  await t.close();
});

test('destinations: validation, limits, isolation, key never returned', async () => {
  const t = await boot();
  const op = t.client(); await op('POST', '/api/login', { email: 'op@x.com', password: 'operpass1' });
  const admin = t.client(); await admin('POST', '/api/login', { email: 'admin@x.com', password: 'adminpass1' });

  const bad = await op('POST', '/api/destinations', { name: 'x', rtmp_url: 'rtmp://localhost/live', stream_key: 'k1234' });
  assert.equal(bad.status, 400);
  const ok = await op('POST', '/api/destinations', { name: 'YT', platform: 'youtube', rtmp_url: 'rtmp://a.rtmp.youtube.com/live2', stream_key: 'abcd-efgh' });
  assert.equal(ok.status, 201);
  assert.ok(!ok.text.includes('abcd-efgh'), 'stream key echoed');
  const id = ok.json.destination.id;
  const list = await op('GET', '/api/status');
  assert.ok(!list.text.includes('abcd-efgh'));
  const raw = t.store.getDestination(id);
  assert.ok(!raw.key_enc.includes('abcd-efgh'), 'stored in plain text');

  assert.equal((await op('POST', '/api/destinations', { name: 'B', rtmp_url: 'rtmp://b.example.com/x', stream_key: 'kkkk1' })).status, 201);
  assert.equal((await op('POST', '/api/destinations', { name: 'C', rtmp_url: 'rtmp://c.example.com/x', stream_key: 'kkkk2' })).status, 400, 'per-user limit');

  // another operator cannot touch it, admin can
  const other = t.store.createUser({ email: 'o2@x.com', name: 'O2', passwordHash: hashPassword('operpass2'), role: 'operator' });
  const op2 = t.client(); await op2('POST', '/api/login', { email: 'o2@x.com', password: 'operpass2' });
  assert.equal((await op2('PATCH', `/api/destinations/${id}`, { enabled: false })).status, 404);
  assert.equal((await op2('DELETE', `/api/destinations/${id}`)).status, 404);
  assert.equal((await op2('GET', '/api/status')).json.destinations.length, 0);
  assert.equal((await admin('PATCH', `/api/destinations/${id}`, { enabled: false })).status, 200);
  assert.equal((await op('DELETE', `/api/destinations/${id}`)).status, 200);
  assert.ok(other);
  await t.close();
});

test('mediamtx auth hook', async () => {
  const t = await boot();
  const c = t.client();
  const key = t.store.getUser(t.opId).ingest_key;
  const call = (b) => c('POST', '/internal/mediamtx-auth', b, { 'x-requested-with': '' });
  assert.equal((await call({ action: 'publish', path: `live/${key}` })).status, 200);
  assert.equal((await call({ action: 'publish', path: 'live/000000000000000000000000' })).status, 401);
  assert.equal((await call({ action: 'publish', path: 'other/' + key })).status, 401);
  assert.equal((await call({ action: 'read', path: `live/${key}`, query: '' })).status, 401, 'outsiders cannot read');
  assert.equal((await call({ action: 'read', path: `live/${key}`, query: 'token=wrong' })).status, 401);
  assert.equal((await call({ action: 'read', path: `live/${key}`, query: 'token=TOK-INTERNAL' })).status, 200);
  t.store.updateUser(t.opId, { active: false });
  assert.equal((await call({ action: 'publish', path: `live/${key}` })).status, 401, 'disabled user cannot publish');
  await t.close();
});

test('static files and path traversal', async () => {
  const t = await boot();
  const c = t.client();
  const home = await c('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Vivid Stream/);
  assert.equal((await c('GET', '/app.js')).status, 200);
  assert.equal((await c('GET', '/..%2fsrc%2fserver.js')).status, 404);
  assert.equal((await c('GET', '/%2e%2e/package.json')).status, 404);
  assert.equal((await c('GET', '/healthz')).status, 200);
  await t.close();
});
