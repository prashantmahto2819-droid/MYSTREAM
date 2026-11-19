import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword } from '../src/crypto.js';
import { makeOAuth } from '../src/oauth.js';
import { createApp } from '../src/server.js';
import { RelayManager } from '../src/relay.js';

const cfgBase = { publicBaseUrl: 'https://live.example.com', googleClientId: 'gid', googleClientSecret: 'gsec', twitchClientId: 'tid', twitchClientSecret: 'tsec', facebookAppId: 'fid', facebookAppSecret: 'fsec',
  mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m', publicRtmpUrl: 'rtmp://r', ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, maxDestinationsPerUser: 5, dataDir: '/tmp' };
const J = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });

function fakeNet(log) {
  let accessCount = 0;
  return async (url, opts = {}) => {
    const u = String(url); log.push([opts.method || 'GET', u, opts.body, opts.headers?.authorization]);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const b = new URLSearchParams(opts.body);
      if (b.get('grant_type') === 'authorization_code') return b.get('code') === 'norefresh' ? J({ access_token: 'A1', expires_in: 3600 }) : J({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 });
      return J({ access_token: `A${++accessCount + 1}`, expires_in: 3600 });
    }
    if (u.includes('/youtube/v3/channels')) return J({ items: [{ id: 'UC123', snippet: { title: 'Tukur Tukoor' } }] });
    if (u.includes('/liveStreams')) return J({ id: 'S1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-1234' } } });
    if (u.includes('/liveBroadcasts?') && u.includes('broadcastStatus=active')) return J({ items: globalThis.__noLive ? [] : [{ snippet: { liveChatId: 'LC1' } }] });
    if (u.includes('/liveChat/messages')) return J({ items: [{ id: 'm1', snippet: { displayMessage: 'Namaste' }, authorDetails: { displayName: 'Ravi' } }, { id: 'm2', snippet: {}, authorDetails: {} }], nextPageToken: 'NP', pollingIntervalMillis: 1000 });
    if (u.includes('/liveBroadcasts/bind')) return J({ id: 'B1' });
    if (u.includes('/liveBroadcasts')) return J({ id: 'B1' });
    if (u.includes('graph.facebook.com') && u.includes('oauth/access_token')) return J({ access_token: u.includes('fb_exchange_token') ? 'LONG' : 'SHORT' });
    if (u.includes('/me/accounts')) return J({ data: [{ id: 'P1', name: 'Page One', access_token: 'PT1' }, { id: 'P2', name: 'Page Two', access_token: 'PT2' }] });
    if (u.includes('/live_videos')) return J({ id: 'LV9', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-KEY-77?s_bl=1' });
    if (u.startsWith('https://id.twitch.tv/oauth2/token')) {
      const b = new URLSearchParams(opts.body);
      return b.get('grant_type') === 'refresh_token' ? J({ access_token: 'TA2', refresh_token: 'TR2', expires_in: 3600 }) : J({ access_token: 'TA1', refresh_token: 'TR1', expires_in: 3600 });
    }
    if (u.startsWith('https://api.twitch.tv/helix/users')) return J({ data: [{ id: 'T77', login: 'prashant', display_name: 'Prashant' }] });
    if (u.startsWith('https://api.twitch.tv/helix/streams/key')) return J({ data: [{ stream_key: 'live_77_abc' }] });
    if (u.startsWith('https://api.twitch.tv/helix/channels')) return J({}, 204);
    return J({ error: { message: 'unexpected ' + u } }, 404);
  };
}

function setup(extra = {}) {
  const store = openDb(':memory:'); const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const log = []; let t = 1_800_000_000_000;
  const oauth = makeOAuth({ cfg: { ...cfgBase, ...extra }, store, vault, fetchImpl: fakeNet(log), now: () => t });
  return { store, vault, uid, oauth, log, advance: (ms) => { t += ms; } };
}

test('oauth: not configured without keys; auth urls carry state and redirect', () => {
  const t = setup({ googleClientId: '' });
  assert.equal(t.oauth.configured().google, false);
  assert.throws(() => t.oauth.authUrl('google', t.uid), /not set up/);
  const u = new URL(t.oauth.authUrl('facebook', t.uid));
  assert.equal(u.searchParams.get('redirect_uri'), 'https://live.example.com/api/oauth/facebook/callback');
  assert.ok(u.searchParams.get('state'));
  const g = setup(); const gu = new URL(g.oauth.authUrl('google', g.uid));
  assert.equal(gu.searchParams.get('access_type'), 'offline'); assert.equal(gu.searchParams.get('prompt'), 'consent');
});

test('oauth google: callback saves encrypted tokens; state is single-use and user-bound', async () => {
  const t = setup();
  const state = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  const ids = await t.oauth.handleCallback('google', { code: 'c', state }, t.uid);
  assert.equal(ids.length, 1);
  const [c] = t.store.listConnections(t.uid);
  assert.equal(c.account_name, 'Tukur Tukoor');
  assert.ok(!JSON.stringify(t.store.getConnection(c.id)).includes('R1'), 'refresh token is encrypted');
  await assert.rejects(() => t.oauth.handleCallback('google', { code: 'c', state }, t.uid), /expired/, 'state used once');
  const s2 = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  await assert.rejects(() => t.oauth.handleCallback('google', { code: 'c', state: s2 }, t.uid + 1), /expired/, 'other user');
  const s3 = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  await assert.rejects(() => t.oauth.handleCallback('google', { code: 'norefresh', state: s3 }, t.uid), /permanent access/);
  const s4 = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  await assert.rejects(() => t.oauth.handleCallback('google', { error: 'access_denied', state: s4 }, t.uid), /cancelled/);
});

test('oauth google: creates stream + broadcast, binds, refreshes expired token', async () => {
  const t = setup();
  const state = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  await t.oauth.handleCallback('google', { code: 'c', state }, t.uid);
  const conn = t.store.listConnections(t.uid)[0];
  const full = () => t.store.getConnection(conn.id);
  let r = await t.oauth.create(full(), { title: 'Morning show', privacy: 'unlisted' });
  assert.deepEqual([r.rtmpUrl, r.streamKey, r.watchUrl, r.platform], ['rtmp://a.rtmp.youtube.com/live2', 'abcd-1234', 'https://youtu.be/B1', 'youtube']);
  assert.ok(t.log.some(([m, u]) => u.includes('liveBroadcasts/bind') && u.includes('streamId=S1')));
  const bc = t.log.find(([, u]) => u.includes('/liveBroadcasts?part'));
  assert.equal(JSON.parse(bc[2]).status.privacyStatus, 'unlisted');
  assert.equal(JSON.parse(bc[2]).contentDetails.enableAutoStart, true);
  assert.equal(t.log.filter(([, u]) => u.includes('oauth2.googleapis.com')).length, 1, 'token still fresh: no refresh');
  t.advance(2 * 3600 * 1000);
  await t.oauth.create(full(), { title: 'Later' });
  assert.equal(t.log.filter(([, u]) => u.includes('oauth2.googleapis.com')).length, 2, 'refreshed once');
  assert.equal(t.log.at(-1)[3], 'Bearer A2');
});

test('oauth facebook: one connection per page, key split from the stream url', async () => {
  const t = setup();
  const state = new URL(t.oauth.authUrl('facebook', t.uid)).searchParams.get('state');
  const ids = await t.oauth.handleCallback('facebook', { code: 'c', state }, t.uid);
  assert.equal(ids.length, 2);
  assert.deepEqual(t.store.listConnections(t.uid).map((c) => c.account_name), ['Page One', 'Page Two']);
  const conn = t.store.getConnection(ids[0]);
  const r = await t.oauth.create(conn, { title: 'News' });
  assert.equal(r.rtmpUrl, 'rtmps://live-api-s.facebook.com:443/rtmp/');
  assert.equal(r.streamKey, 'FB-KEY-77?s_bl=1');
  assert.ok(t.log.at(-1)[1].includes('/P1/live_videos'));
});

async function boot() {
  const t = setup();
  const cfg = { ...cfgBase };
  const relay = new RelayManager({ store: t.store, vault: t.vault, cfg, internalToken: 'T', log: { error() {}, warn() {}, info() {} }, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('x'); } });
  const server = createApp({ cfg, store: t.store, relay, internalToken: 'T', processor: {}, player: {}, oauth: t.oauth, log: { error() {}, warn() {}, info() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `sid=${t.store.createSession(t.uid, 3600000)}`;
  const call = (m, p, body) => fetch(base + p, { method: m, redirect: 'manual', headers: { cookie, 'x-requested-with': 'vivid', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { ...t, call, cookie, base };
}

test('oauth routes: start redirects, callback connects, go-live creates a destination, delete', async () => {
  const t = await boot();
  assert.equal((await fetch(t.base + '/api/connections')).status, 401);
  let r = await t.call('GET', '/api/connections');
  assert.equal((await r.json()).configured.google, true);

  r = await t.call('GET', '/api/oauth/google/start');
  assert.equal(r.status, 302);
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  assert.equal((await t.call('GET', '/api/oauth/other/start')).status, 404);

  r = await t.call('GET', `/api/oauth/google/callback?code=c&state=${state}`);
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/?connected=1#destinations');
  r = await t.call('GET', `/api/oauth/google/callback?code=c&state=bad`);
  assert.match(decodeURIComponent(r.headers.get('location')), /oauth_error=Sign-in expired/);

  const conn = (await (await t.call('GET', '/api/connections')).json()).connections[0];
  assert.equal(conn.account_name, 'Tukur Tukoor');
  assert.ok(!JSON.stringify(conn).includes('token'));

  r = await t.call('POST', `/api/connections/${conn.id}/go-live`, { title: '' });
  assert.equal(r.status, 400);
  r = await t.call('POST', `/api/connections/${conn.id}/go-live`, { title: 'Evening live', privacy: 'public' });
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.equal(out.watch_url, 'https://youtu.be/B1');
  assert.equal(out.destination.name, 'YouTube: Evening live');
  assert.equal(out.destination.rtmp_url, 'rtmp://a.rtmp.youtube.com/live2');
  assert.equal(t.vault.decrypt(t.store.getDestination(out.destination.id).key_enc), 'abcd-1234');
  assert.ok(!JSON.stringify(out).includes('abcd-1234'), 'key not returned');

  assert.equal((await t.call('POST', `/api/connections/999/go-live`, { title: 'x' })).status, 404);
  assert.equal((await t.call('DELETE', `/api/connections/${conn.id}`)).status, 200);
  assert.equal((await (await t.call('GET', '/api/connections')).json()).connections.length, 0);
});

test('youtube chat: finds the live chat, returns clean messages, paging token and a safe wait', async () => {
  const t = setup();
  const state = new URL(t.oauth.authUrl('google', t.uid)).searchParams.get('state');
  await t.oauth.handleCallback('google', { code: 'c', state }, t.uid);
  const conn = t.store.listConnections(t.uid)[0];
  const full = t.store.getConnection(conn.id);
  const r = await t.oauth.youtubeChat(full, '');
  assert.deepEqual(r.messages, [{ id: 'm1', author: 'Ravi', text: 'Namaste' }]);
  assert.equal(r.next, 'NP'); assert.equal(r.waitMs, 3000, 'never faster than every 3 s');
  await t.oauth.youtubeChat(full, 'NP');
  assert.ok(t.log.at(-1)[1].includes('pageToken=NP') && t.log.at(-1)[1].includes('liveChatId=LC1'));
  assert.equal(t.log.filter(([, u]) => u.includes('broadcastStatus=active')).length, 1, 'chat id cached');
  globalThis.__noLive = true;
  const t2 = setup();
  const s2 = new URL(t2.oauth.authUrl('google', t2.uid)).searchParams.get('state');
  await t2.oauth.handleCallback('google', { code: 'c', state: s2 }, t2.uid);
  await assert.rejects(() => t2.oauth.youtubeChat(t2.store.getConnection(t2.store.listConnections(t2.uid)[0].id)), /No live broadcast/);
  globalThis.__noLive = false;
});

test('oauth twitch: connect, then create live returns the stream key and sets the title', async () => {
  const t = setup();
  const u = new URL(t.oauth.authUrl('twitch', t.uid));
  assert.equal(u.origin + u.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.match(u.searchParams.get('scope'), /channel:read:stream_key/);
  await t.oauth.handleCallback('twitch', { code: 'c', state: u.searchParams.get('state') }, t.uid);
  const [c] = t.store.listConnections(t.uid);
  assert.equal(c.provider, 'twitch'); assert.equal(c.account_name, 'Prashant');
  assert.ok(!JSON.stringify(t.store.getConnection(c.id)).includes('TR1'), 'refresh token is encrypted');
  const made = await t.oauth.create(t.store.getConnection(c.id), { title: 'Aaj ki live' });
  assert.equal(made.rtmpUrl, 'rtmp://live.twitch.tv/app'); assert.equal(made.streamKey, 'live_77_abc'); assert.equal(made.platform, 'twitch');
  assert.equal(made.watchUrl, 'https://www.twitch.tv/prashant');
  assert.ok(t.log.some(([m, url]) => m === 'PATCH' && url.includes('/helix/channels')), 'title was set');
  t.advance(2 * 3600 * 1000);
  await t.oauth.create(t.store.getConnection(c.id), { title: 'again' });
  assert.ok(t.log.some(([, url, body]) => url.includes('id.twitch.tv/oauth2/token') && String(body).includes('refresh_token')), 'expired token refreshed');
});

test('oauth setup from the dashboard: saved encrypted, beats .env, secrets never returned, bad address refused', () => {
  const t = setup({ googleClientId: '', googleClientSecret: '', publicBaseUrl: '' });
  assert.equal(t.oauth.configured().google, false);
  t.oauth.saveSetup({ publicBaseUrl: 'https://live.example.com/', googleClientId: 'GID-1', googleClientSecret: 'SECRET-1' });
  assert.equal(t.oauth.configured().google, true);
  const st = t.oauth.setupStatus();
  assert.equal(st.publicBaseUrl, 'https://live.example.com');
  assert.equal(st.set.googleClientId, true);
  assert.ok(!JSON.stringify(st).includes('SECRET-1') && !JSON.stringify(st).includes('GID-1'));
  assert.ok(!t.store.getSetting('oauth_googleClientSecret').includes('SECRET-1'), 'stored encrypted');
  assert.equal(st.redirects.twitch, 'https://live.example.com/api/oauth/twitch/callback');
  assert.throws(() => t.oauth.saveSetup({ publicBaseUrl: 'javascript:alert(1)' }), /site address/);
  t.oauth.saveSetup({ clear: ['googleClientSecret'] });
  assert.equal(t.oauth.configured().google, false);
});

test('connections table accepts twitch and old databases are migrated', () => {
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'z@x.com', name: 'Z', passwordHash: 'h' });
  assert.ok(store.upsertConnection({ userId: uid, provider: 'twitch', remoteId: '1', accountName: 'T', tokenEnc: 'x' }) > 0);
  assert.equal(store.getSetting('nope'), null);
  store.setSetting('k', 'v'); store.setSetting('k', 'v2'); assert.equal(store.getSetting('k'), 'v2');
});
