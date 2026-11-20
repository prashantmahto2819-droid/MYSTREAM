import http from 'node:http';
import { summarize } from './analytics.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { attachStudio } from './studio.js';
import { attachGuests } from './guests.js';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { makeVault, hashPassword, verifyPassword, randomToken, safeEqual, sha256 } from './crypto.js';
import { RelayManager } from './relay.js';
import { VideoProcessor, VIDEO_EXTS } from './media.js';
import { SchedulePlayer } from './player.js';
import { Notifier } from './notify.js';
import { Recorder } from './recorder.js';
import { relayEventHandler, playerEventHandler, recorderEventHandler, standbyEventHandler } from './alerts.js';
import { Standby } from './standby.js';
import { validateEvent, newSlug, embedUrl, clean, EventReminders } from './events.js';
import { makeOAuth, OAuthError } from './oauth.js';
import {
  PRESETS, cleanPlatform, validateRtmpUrl, validateStreamKey,
  validateName, validateEmail, validatePassword,
} from './validate.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MAX_CHUNK = 32 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

export function createApp({ cfg, store, relay, internalToken, processor, player, log = console, spawn, standby = null, oauth = null }) {
  const vault = relay.vault;
  const regHits = new Map(); // ip -> timestamps (event registrations)
  const loginFails = new Map(); // "ip|email" -> { n, until }

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(status, {
      'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });

  const parseCookies = (req) => Object.fromEntries(
    String(req.headers.cookie || '').split(';').map((p) => p.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k)
  );

  const cookieHeader = (req, value, maxAgeSec) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
  };

  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  const needAdmin = (user) => { if (user.role !== 'admin') throw new HttpError(403, 'Admin only'); };
  // API keys may not manage keys, passwords, stream keys or team members.
  const needSession = (ctx) => { if (ctx.viaKey) throw new HttpError(403, 'Not allowed with an API key'); };

  const destView = (d) => ({
    id: d.id, name: d.name, platform: d.platform, rtmp_url: d.rtmp_url,
    enabled: !!d.enabled, user_id: d.user_id, group_name: d.group_name || '', ...relay.statusFor(d.id),
  });

  const ownedDestination = (user, id) => {
    const d = store.getDestination(Number(id));
    if (!d || (d.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
    return d;
  };

  // ---------- public / internal routes ----------
  route('GET', '/healthz', async (_req, res) => send(res, 200, { ok: true, mediamtx: relay.apiOk }), { auth: false });

  // MediaMTX asks us whether a connection is allowed.
  route('POST', '/internal/mediamtx-auth', async (req, res) => {
    const b = await readJson(req);
    const action = b.action;
    if (action === 'publish') {
      const m = /^live\/([0-9a-f]{24})$/.exec(String(b.path || ''));
      const user = m && store.getUserByIngestKey(m[1]);
      return user && user.active ? send(res, 200, {}) : send(res, 401, {});
    }
    if (action === 'read') {
      // Only our own ffmpeg relays may read, using the per-process token.
      const token = new URLSearchParams(String(b.query || '')).get('token');
      return token && safeEqual(token, internalToken) ? send(res, 200, {}) : send(res, 401, {});
    }
    // api/metrics/pprof are excluded from auth in mediamtx.yml; deny anything else.
    return send(res, 401, {});
  }, { auth: false, csrf: false });

  route('POST', '/api/login', async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const id = `${clientIp(req)}|${email}`;
    const f = loginFails.get(id);
    if (f && f.n >= 5 && f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const user = store.getUserByEmail(email);
    const ok = user && user.active && verifyPassword(String(b.password || ''), user.password_hash);
    if (!ok) {
      const n = (f && f.until > Date.now() ? f.n : 0) + 1;
      loginFails.set(id, { n, until: Date.now() + 10 * 60 * 1000 });
      throw new HttpError(401, 'Wrong email or password');
    }
    loginFails.delete(id);
    const token = store.createSession(user.id, SESSION_TTL_MS);
    store.addActivity(user.id, 'login');
    send(res, 200, { user: publicUser(user) }, { 'set-cookie': cookieHeader(req, token, SESSION_TTL_MS / 1000) });
  }, { auth: false });

  route('POST', '/api/logout', async (req, res) => {
    const token = parseCookies(req).sid;
    if (token) store.deleteSession(token);
    send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, '', 0) });
  }, { auth: false });

  // ---------- authenticated routes ----------
  route('GET', '/api/me', async (_req, res, { user }) => send(res, 200, { user: publicUser(user) }));

  route('GET', '/api/presets', async (_req, res) => send(res, 200, { presets: PRESETS }));

  route('GET', '/api/status', async (_req, res, { user }) => {
    const dests = (user.role === 'admin' ? store.listAllDestinations() : store.listDestinations(user.id)).map(destView);
    send(res, 200, {
      ingest: { url: cfg.publicRtmpUrl, key: user.ingest_key, live: relay.isIngestLive(user.ingest_key) },
      mediamtxOk: relay.apiOk,
      standby: { active: !!standby?.isActive(user.id), since: standby?.since(user.id) || null },
      destinations: dests,
    });
  });

  // A plain-language "is everything set up?" list for the Settings tab.
  route('GET', '/api/readiness', async (_req, res, { user }) => {
    const dests = store.listDestinations(user.id);
    const conns = oauth ? store.listConnections(user.id) : [];
    const base = (oauth?.setupStatus?.().publicBaseUrl) || cfg.publicBaseUrl || '';
    const items = [
      { id: 'mediamtx', ok: relay.apiOk !== false, title: 'Streaming engine (MediaMTX) is running', fix: 'Run: docker compose up -d, then check docker compose logs mediamtx.' },
      { id: 'destinations', ok: dests.some((d) => d.enabled), title: 'At least one enabled destination', fix: 'Destinations tab -> + Add channel or + Add destination.' },
      { id: 'channels', ok: conns.length > 0, title: 'A YouTube / Facebook / Twitch channel is connected (one-click keys, chat, viewers)', fix: 'Destinations tab -> + Add channel.' },
      { id: 'baseurl', ok: !!base, title: 'Site address (PUBLIC_BASE_URL / https) is set', fix: 'Set PUBLIC_BASE_URL in .env (https://your-domain) or save it in the Add channel setup popup.' },
      { id: 'alerts', ok: !!cfg.alertUrl, title: 'WhatsApp alert endpoint is configured', fix: 'Set ALERT_WEBHOOK_URL (your Vivid Relay send address) in .env.' },
      { id: 'phone', ok: !!user.phone, title: 'Your phone number is saved for alerts', fix: 'Settings tab -> WhatsApp alerts -> save your number with country code.' },
      { id: 'record', ok: !!user.record, title: 'Recording of OBS lives is on (backup copy)', fix: 'Settings tab -> turn on recording.' },
      { id: 'https', ok: base ? base.startsWith('https://') : false, title: 'Dashboard is served over https', fix: 'Put Cloudflare Tunnel or Caddy in front so the address starts with https://.' },
    ];
    send(res, 200, { items, done: items.filter((i) => i.ok).length, total: items.length });
  });

  route('POST', '/api/me/rotate-ingest-key', async (_req, res, ctx) => {
    needSession(ctx);
    const { user } = ctx;
    const key = store.rotateIngestKey(user.id);
    store.addActivity(user.id, 'ingest_key_rotated');
    send(res, 200, { key });
  });

  route('POST', '/api/destinations', async (req, res, { user }) => {
    const b = await readJson(req);
    const name = validateName(b.name);
    const url = validateRtmpUrl(b.rtmp_url);
    const key = validateStreamKey(b.stream_key);
    for (const v of [name, url, key]) if (!v.ok) throw new HttpError(400, v.error);
    if (store.countDestinations(user.id) >= cfg.maxDestinationsPerUser) {
      throw new HttpError(400, `Limit reached (${cfg.maxDestinationsPerUser} destinations)`);
    }
    const id = store.createDestination({
      userId: user.id, name: name.value, platform: cleanPlatform(b.platform),
      rtmpUrl: url.url, keyEnc: vault.encrypt(key.key),
    });
    store.addActivity(user.id, 'destination_added', name.value);
    send(res, 201, { destination: destView(store.getDestination(id)) });
  });

  route('PATCH', '/api/destinations/:id', async (req, res, { user, params }) => {
    const d = ownedDestination(user, params.id);
    const b = await readJson(req);
    const patch = {};
    if (b.name !== undefined) { const v = validateName(b.name); if (!v.ok) throw new HttpError(400, v.error); patch.name = v.value; }
    if (b.rtmp_url !== undefined) { const v = validateRtmpUrl(b.rtmp_url); if (!v.ok) throw new HttpError(400, v.error); patch.rtmpUrl = v.url; }
    if (b.stream_key !== undefined && b.stream_key !== '') {
      const v = validateStreamKey(b.stream_key); if (!v.ok) throw new HttpError(400, v.error);
      patch.keyEnc = vault.encrypt(v.key);
    }
    if (b.platform !== undefined) patch.platform = cleanPlatform(b.platform);
    if (b.group_name !== undefined) patch.groupName = String(b.group_name).trim().slice(0, 30);
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    store.updateDestination(d.id, patch);
    if (patch.enabled !== undefined) {
      store.addActivity(user.id, patch.enabled ? 'destination_enabled' : 'destination_disabled', d.name);
    }
    send(res, 200, { destination: destView(store.getDestination(d.id)) });
    relay.tick().catch(() => {}); // apply immediately instead of waiting for the next poll
  });

  route('DELETE', '/api/destinations/:id', async (_req, res, { user, params }) => {
    const d = ownedDestination(user, params.id);
    relay.stop(d.id, 'deleted');
    store.deleteDestination(d.id);
    store.addActivity(user.id, 'destination_deleted', d.name);
    send(res, 200, { ok: true });
  });

  route('GET', '/api/activity', async (_req, res, { user }) => {
    send(res, 200, { activity: store.listActivity(user.role === 'admin' ? null : user.id) });
  });

  route('GET', '/api/analytics', async (_req, res, { user }) => {
    send(res, 200, summarize(store.activitySince(user.role === 'admin' ? null : user.id, 14), { days: 14 }));
  });

  route('PATCH', '/api/me', async (req, res, { user }) => {
    const b = await readJson(req);
    if (b.phone !== undefined) {
      const p = String(b.phone).replace(/[\s-]/g, '');
      if (p !== '' && !/^\+?\d{8,15}$/.test(p)) throw new HttpError(400, 'Enter the number with country code, e.g. 919876543210');
      store.updateUser(user.id, { phone: p });
    }
    if (b.standby !== undefined) store.updateUser(user.id, { standby: !!b.standby });
    if (b.standby_text !== undefined) store.updateUser(user.id, { standbyText: String(b.standby_text).trim().slice(0, 80) });
    if (b.standby_minutes !== undefined) {
      const n = Number(b.standby_minutes);
      if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'Standby minutes must be 1 to 60');
      store.updateUser(user.id, { standbyMinutes: n });
    }
    if (b.record !== undefined) {
      store.updateUser(user.id, { record: !!b.record });
      store.addActivity(user.id, b.record ? 'recording_enabled' : 'recording_disabled');
    }
    send(res, 200, { ok: true });
  });

  // ---------- connected YouTube / Facebook accounts ----------
  const needOAuth = () => { if (!oauth) throw new HttpError(400, 'Not available'); };
  const oauthError = (e) => { if (e instanceof OAuthError) throw new HttpError(400, e.message); throw e; };
  route('GET', '/api/connections', async (_req, res, ctx) => {
    needSession(ctx); needOAuth();
    send(res, 200, { configured: oauth.configured(), connections: store.listConnections(ctx.user.id) });
  });
  route('GET', '/api/oauth/:provider/start', async (_req, res, ctx) => {
    needSession(ctx); needOAuth();
    if (!['google', 'facebook', 'twitch'].includes(ctx.params.provider)) throw new HttpError(404, 'Not found');
    let url; try { url = oauth.authUrl(ctx.params.provider, ctx.user.id); } catch (e) { oauthError(e); }
    res.writeHead(302, { location: url, 'cache-control': 'no-store' }); res.end();
  });
  route('GET', '/api/oauth/:provider/callback', async (req, res, ctx) => {
    needSession(ctx); needOAuth();
    if (!['google', 'facebook', 'twitch'].includes(ctx.params.provider)) throw new HttpError(404, 'Not found');
    const q = new URL(req.url, 'http://x').searchParams;
    let where;
    try {
      const ids = await oauth.handleCallback(ctx.params.provider, { code: q.get('code'), state: q.get('state'), error: q.get('error') }, ctx.user.id);
      store.addActivity(ctx.user.id, 'account_connected', ctx.params.provider);
      where = `/?connected=${ids.length}#destinations`;
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      where = `/?oauth_error=${encodeURIComponent(e.message)}#destinations`;
    }
    res.writeHead(302, { location: where, 'cache-control': 'no-store' }); res.end();
  });
  route('GET', '/api/oauth-setup', async (_req, res, ctx) => {
    needSession(ctx); needOAuth(); needAdmin(ctx.user);
    send(res, 200, oauth.setupStatus());
  });
  route('PUT', '/api/oauth-setup', async (req, res, ctx) => {
    needSession(ctx); needOAuth(); needAdmin(ctx.user);
    const b = await readJson(req);
    try { oauth.saveSetup(b); } catch (e) { oauthError(e); }
    store.addActivity(ctx.user.id, 'channel_setup_saved');
    send(res, 200, oauth.setupStatus());
  });
  route('GET', '/api/chat/youtube', async (req, res, ctx) => {
    needSession(ctx); needOAuth();
    const q = new URL(req.url, 'http://x').searchParams;
    const c = store.getConnection(Number(q.get('connection')));
    if (!c || c.user_id !== ctx.user.id) throw new HttpError(404, 'Not found');
    let out; try { out = await oauth.youtubeChat(c, String(q.get('page') || '').slice(0, 300)); } catch (e) { oauthError(e); }
    send(res, 200, out);
  });
  route('GET', '/api/viewers', async (_req, res, ctx) => {
    needSession(ctx); needOAuth();
    const out = [];
    for (const c of store.listConnections(ctx.user.id)) {
      try { const v = await oauth.viewers(c); if (v) out.push({ provider: c.provider, account: c.account_name, ...v }); }
      catch { out.push({ provider: c.provider, account: c.account_name, live: false, viewers: 0, error: true }); }
    }
    send(res, 200, { total: out.reduce((n, x) => n + x.viewers, 0), channels: out });
  });
  route('POST', '/api/live-summary', async (req, res, ctx) => {
    needSession(ctx);
    const b = await readJson(req);
    const peak = Math.min(Math.max(Math.floor(Number(b.peak)) || 0, 0), 10_000_000);
    if (peak > 0) store.addActivity(ctx.user.id, 'live_summary', `peak ${peak} viewers`);
    send(res, 200, { ok: true });
  });
  route('DELETE', '/api/connections/:id', async (_req, res, ctx) => {
    needSession(ctx); needOAuth();
    const c = store.getConnection(Number(ctx.params.id));
    if (!c || c.user_id !== ctx.user.id) throw new HttpError(404, 'Not found');
    store.deleteConnection(c.id);
    send(res, 200, { ok: true });
  });
  route('POST', '/api/connections/:id/go-live', async (req, res, ctx) => {
    needSession(ctx); needOAuth();
    const { user } = ctx;
    const c = store.getConnection(Number(ctx.params.id));
    if (!c || c.user_id !== user.id) throw new HttpError(404, 'Not found');
    const b = await readJson(req);
    const title = validateName(b.title, 'Title');
    if (!title.ok) throw new HttpError(400, title.error);
    if (store.countDestinations(user.id) >= cfg.maxDestinationsPerUser) throw new HttpError(400, `Limit reached (${cfg.maxDestinationsPerUser} destinations)`);
    const privacy = ['public', 'unlisted', 'private'].includes(b.privacy) ? b.privacy : 'unlisted';
    const startAt = b.start_at ? Number(b.start_at) : null;
    if (startAt !== null && (!Number.isFinite(startAt) || startAt < Date.now() - 60000)) throw new HttpError(400, 'Start time must be in the future');
    let made;
    try { made = await oauth.create(c, { title: title.value, privacy, startAt, description: String(b.description || '').slice(0, 2000) }); } catch (e) { oauthError(e); }
    const url = validateRtmpUrl(made.rtmpUrl);
    const key = validateStreamKey(made.streamKey);
    if (!url.ok || !key.ok) throw new HttpError(502, 'The platform returned an unusable stream address.');
    const id = store.createDestination({ userId: user.id, name: made.name.slice(0, 80), platform: cleanPlatform(made.platform), rtmpUrl: url.url, keyEnc: vault.encrypt(key.key) });
    store.addActivity(user.id, 'live_created', `${made.name}`);
    send(res, 201, { destination: destView(store.getDestination(id)), watch_url: made.watchUrl });
  });

  let guestsApi = null;
  route('POST', '/api/studio/invite', async (_req, res, ctx) => {
    needSession(ctx);
    const { token } = guestsApi.createInvite(ctx.user.id);
    send(res, 200, { token, url: `/join.html#${token}` });
  });
  route('DELETE', '/api/studio/invite', async (_req, res, ctx) => {
    needSession(ctx);
    guestsApi.revokeInvite(ctx.user.id);
    send(res, 200, { ok: true });
  });

  route('POST', '/api/standby/stop', async (_req, res, { user }) => {
    send(res, 200, { ok: true, stopped: !!standby?.stop(user.id) });
  });

  route('GET', '/api/me/settings', async (_req, res, { user }) => {
    const u = store.getUser(user.id);
    send(res, 200, { phone: u.phone, record: !!u.record, standby: !!u.standby, standby_text: u.standby_text, standby_minutes: u.standby_minutes, alertsConfigured: !!cfg.alertUrl, recordingKeepDays: cfg.recordingKeepDays });
  });

  // ---------- password + API keys (browser session only) ----------
  route('POST', '/api/me/password', async (req, res, ctx) => {
    needSession(ctx);
    const { user } = ctx;
    const b = await readJson(req);
    const full = store.getUser(user.id);
    if (!verifyPassword(String(b.current || ''), full.password_hash)) throw new HttpError(400, 'Current password is wrong');
    const pw = validatePassword(b.new);
    if (!pw.ok) throw new HttpError(400, pw.error);
    store.updateUser(user.id, { passwordHash: hashPassword(pw.value) });
    store.deleteUserSessions(user.id); // signs out every device, including this one
    store.addActivity(user.id, 'password_changed');
    const token = store.createSession(user.id, SESSION_TTL_MS);
    send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, token, SESSION_TTL_MS / 1000) });
  });

  route('GET', '/api/keys', async (_req, res, ctx) => {
    needSession(ctx);
    send(res, 200, { keys: store.listApiKeys(ctx.user.id) });
  });

  route('POST', '/api/keys', async (req, res, ctx) => {
    needSession(ctx);
    const { user } = ctx;
    const name = validateName((await readJson(req)).name, 'Key name');
    if (!name.ok) throw new HttpError(400, name.error);
    if (store.listApiKeys(user.id).length >= 10) throw new HttpError(400, 'Limit reached (10 API keys)');
    const token = `vs_${randomToken(20)}`;
    store.createApiKey({ userId: user.id, name: name.value, tokenHash: sha256(token), prefix: token.slice(0, 7) });
    store.addActivity(user.id, 'api_key_created', name.value);
    send(res, 201, { token }); // shown once; only a hash is stored
  });

  route('DELETE', '/api/keys/:id', async (_req, res, ctx) => {
    needSession(ctx);
    const n = store.deleteApiKey(Number(ctx.params.id), ctx.user.id);
    if (!n) throw new HttpError(404, 'Not found');
    store.addActivity(ctx.user.id, 'api_key_deleted');
    send(res, 200, { ok: true });
  });

  // ---------- recordings of lives ----------
  const ownedRecording = (user, id) => {
    const r = store.getRecording(Number(id));
    if (!r || (r.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
    return r;
  };
  const recView = (r) => ({ id: r.id, title: r.title, size: r.size, status: r.status, started_at: r.started_at, ended_at: r.ended_at, user_id: r.user_id });

  route('GET', '/api/recordings', async (_req, res, { user }) => {
    send(res, 200, { recordings: store.listRecordings(user.role === 'admin' ? null : user.id).map(recView) });
  });

  route('GET', '/api/recordings/:id/download', async (req, res, { user, params }) => {
    const r = ownedRecording(user, params.id);
    if (r.status !== 'done' || !fs.existsSync(r.file_path)) throw new HttpError(409, 'Recording is not ready');
    const total = fs.statSync(r.file_path).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0; let end = total - 1; let status = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), total - 1); } else { start = Math.max(0, total - Number(m[2])); }
      if (start > end || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); return res.end(); }
      status = 206;
    }
    const headers = {
      'content-type': 'video/x-matroska', 'content-length': end - start + 1, 'accept-ranges': 'bytes',
      'content-disposition': `attachment; filename="recording-${r.id}.mkv"`, 'cache-control': 'no-store',
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, headers);
    fs.createReadStream(r.file_path, { start, end }).pipe(res);
  });

  route('DELETE', '/api/recordings/:id', async (_req, res, { user, params }) => {
    const r = ownedRecording(user, params.id);
    if (r.status === 'recording') throw new HttpError(409, 'Still recording. Stop the live first.');
    fs.rmSync(r.file_path, { force: true });
    store.deleteRecording(r.id);
    store.addActivity(user.id, 'recording_deleted', r.title);
    send(res, 200, { ok: true });
  });

  // Turns a recording into a normal video that can be scheduled again.
  route('POST', '/api/recordings/:id/to-video', async (_req, res, { user, params }) => {
    const r = ownedRecording(user, params.id);
    if (r.status !== 'done' || !fs.existsSync(r.file_path)) throw new HttpError(409, 'Recording is not ready');
    const dir = path.join(cfg.dataDir, 'videos', String(r.user_id));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.mkv`);
    fs.renameSync(r.file_path, file);
    const size = fs.statSync(file).size;
    const id = store.createVideo({ userId: r.user_id, title: r.title, filePath: file, ext: 'mkv', expectedSize: size });
    store.updateVideo(id, { status: 'processing', size });
    store.deleteRecording(r.id);
    store.addActivity(user.id, 'recording_to_video', r.title);
    processor?.enqueue(id);
    send(res, 200, { video_id: id });
  });

  // ---------- videos: resumable upload ----------
  const ownedVideo = (user, id) => {
    const v = store.getVideo(Number(id));
    if (!v || (v.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
    return v;
  };
  const videoView = (v) => ({
    id: v.id, user_id: v.user_id, title: v.title, status: v.status, error: v.error, size: v.size,
    expected_size: v.expected_size, duration: v.duration, width: v.width, height: v.height, fps: v.fps,
    created_at: v.created_at, in_use: store.videoInUse(v.id),
  });
  const freeBytes = () => { const s = fs.statfsSync(cfg.dataDir); return Number(s.bavail) * Number(s.bsize); };

  route('GET', '/api/storage', async (_req, res, { user }) => {
    send(res, 200, {
      freeBytes: freeBytes(), usedBytes: store.storageUsed(user.id),
      quotaBytes: cfg.userQuotaBytes, maxUploadBytes: cfg.maxUploadBytes,
    });
  });

  route('GET', '/api/videos', async (_req, res, { user }) => {
    const list = store.listVideos(user.role === 'admin' ? null : user.id);
    send(res, 200, { videos: list.map(videoView) });
  });

  route('POST', '/api/uploads', async (req, res, { user }) => {
    const b = await readJson(req);
    const filename = String(b.filename || '');
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (!VIDEO_EXTS.has(ext)) throw new HttpError(400, `Unsupported file type. Use: ${[...VIDEO_EXTS].join(', ')}`);
    const baseName = filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const title = validateName(b.title || baseName, 'Title');
    if (!title.ok) throw new HttpError(400, title.error);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Invalid file size');
    if (size > cfg.maxUploadBytes) throw new HttpError(400, `File is larger than the ${(cfg.maxUploadBytes / 1024 ** 3).toFixed(0)} GB limit`);
    if (store.storageUsed(user.id) + size > cfg.userQuotaBytes) throw new HttpError(400, 'Your storage quota is full. Delete old videos first.');
    if (freeBytes() - cfg.diskReserveBytes < size) throw new HttpError(507, 'Not enough free disk space on the server');

    const dir = path.join(cfg.dataDir, 'videos', String(user.id));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
    fs.writeFileSync(file, '');
    const id = store.createVideo({ userId: user.id, title: title.value, filePath: file, ext, expectedSize: size });
    send(res, 201, { id, chunkSize: CHUNK_SIZE });
  });

  route('GET', '/api/uploads/:id', async (_req, res, { user, params }) => {
    const v = ownedVideo(user, params.id);
    const received = fs.existsSync(v.file_path) ? fs.statSync(v.file_path).size : 0;
    send(res, 200, { received, size: v.expected_size, status: v.status });
  });

  route('PUT', '/api/uploads/:id', async (req, res, { user, params }) => {
    const v = ownedVideo(user, params.id);
    if (v.status !== 'uploading') { req.resume(); throw new HttpError(409, 'Upload already finished'); }
    const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
    const len = Number(req.headers['content-length']);
    if (!Number.isInteger(offset) || offset < 0) { req.resume(); throw new HttpError(400, 'Invalid offset'); }
    if (!Number.isInteger(len) || len <= 0 || len > MAX_CHUNK) { req.resume(); throw new HttpError(400, 'Chunk must be 1 byte to 32 MB'); }
    const current = fs.existsSync(v.file_path) ? fs.statSync(v.file_path).size : 0;
    if (offset !== current) { req.resume(); return send(res, 409, { error: 'Offset mismatch', received: current }); }
    if (current + len > v.expected_size) { req.resume(); throw new HttpError(400, 'Chunk goes past the end of the file'); }
    try {
      await pipeline(req, fs.createWriteStream(v.file_path, { flags: 'a' }));
    } finally {
      store.updateVideo(v.id, { size: fs.statSync(v.file_path).size });
    }
    send(res, 200, { received: fs.statSync(v.file_path).size });
  });

  route('POST', '/api/uploads/:id/complete', async (_req, res, { user, params }) => {
    const v = ownedVideo(user, params.id);
    if (v.status !== 'uploading') throw new HttpError(409, 'Upload already finished');
    const size = fs.statSync(v.file_path).size;
    if (size !== v.expected_size) throw new HttpError(400, `Upload incomplete (${size} of ${v.expected_size} bytes)`);
    store.updateVideo(v.id, { status: 'processing', size });
    store.addActivity(user.id, 'video_uploaded', v.title);
    processor?.enqueue(v.id);
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/videos/:id', async (_req, res, { user, params }) => {
    const v = ownedVideo(user, params.id);
    if (v.status === 'processing') throw new HttpError(409, 'This video is being prepared. Try again in a few minutes.');
    if (store.videoInUse(v.id)) throw new HttpError(409, 'This video is part of a scheduled live. Cancel that schedule first.');
    fs.rmSync(v.file_path, { force: true });
    fs.rmSync(`${v.file_path}.conv.mp4`, { force: true });
    store.deleteVideo(v.id);
    store.addActivity(user.id, 'video_deleted', v.title);
    send(res, 200, { ok: true });
  });

  // ---------- schedules ----------
  const scheduleWindow = (s, startAt, loops, videoIds) => {
    const dur = videoIds.reduce((t, id) => t + (store.getVideo(id)?.duration || 0), 0);
    return { start: startAt, end: loops === 0 ? Infinity : startAt + dur * 1000 * loops + 60000 };
  };
  const scheduleView = (s) => ({
    id: s.id, user_id: s.user_id, title: s.title, status: s.status, error: s.error, start_at: s.start_at,
    loop_count: s.loop_count, delete_after: !!s.delete_after, dest_ids: s.dest_ids, started_at: s.started_at,
    ended_at: s.ended_at, videos: s.video_ids.map((id) => store.getVideo(id)?.title || '(deleted)'),
  });

  route('GET', '/api/schedules', async (_req, res, { user }) => {
    send(res, 200, { schedules: store.listSchedules(user.role === 'admin' ? null : user.id).map(scheduleView) });
  });

  route('POST', '/api/schedules', async (req, res, { user }) => {
    const b = await readJson(req);
    const ids = [...new Set((Array.isArray(b.video_ids) ? b.video_ids : []).map(Number))];
    if (!ids.length || ids.length > 20 || ids.some((n) => !Number.isInteger(n))) throw new HttpError(400, 'Choose 1 to 20 videos');
    const videos = ids.map((id) => store.getVideo(id));
    if (videos.some((v) => !v || v.user_id !== user.id)) throw new HttpError(400, 'Unknown video');
    if (videos.some((v) => v.status !== 'ready')) throw new HttpError(400, 'All videos must be ready (finished uploading and preparing)');

    const startAt = Number(b.start_at);
    const now = Date.now();
    if (!Number.isInteger(startAt) || startAt < now - 30000) throw new HttpError(400, 'Start time must be in the future');
    if (startAt > now + 366 * 24 * 3600 * 1000) throw new HttpError(400, 'Start time is too far away');
    const loops = b.loop_count === undefined ? 1 : Number(b.loop_count);
    if (!Number.isInteger(loops) || loops < 0 || loops > 50) throw new HttpError(400, 'Repeat must be 0 (until stopped) to 50');

    let destIds = null;
    if (Array.isArray(b.dest_ids) && b.dest_ids.length) {
      destIds = b.dest_ids.map(Number);
      const own = new Set(store.listDestinations(user.id).map((d) => d.id));
      if (destIds.some((n) => !own.has(n))) throw new HttpError(400, 'Unknown destination');
    }
    const usable = store.listEnabledDestinations(user.id).filter((d) => !destIds || destIds.includes(d.id));
    if (!usable.length) throw new HttpError(400, 'Add and enable at least one destination first');

    // Copy-mode playlists need matching video parameters, or players may glitch at the join.
    const [first] = videos;
    for (const v of videos) {
      if (v.width !== first.width || v.height !== first.height || Math.abs((v.fps || 0) - (first.fps || 0)) > 0.5) {
        throw new HttpError(400, `Videos in one playlist must have the same size and frame rate ("${first.title}" is ${first.width}x${first.height} @${first.fps}fps, "${v.title}" is ${v.width}x${v.height} @${v.fps}fps). Schedule them separately.`);
      }
    }

    const mine = scheduleWindow(null, startAt, loops, ids);
    for (const o of store.listActiveSchedules(user.id)) {
      const w = scheduleWindow(o, o.start_at, o.loop_count, o.video_ids);
      if (mine.start < w.end && w.start < mine.end) {
        throw new HttpError(409, `This overlaps with your other live "${o.title}". One stream key can only carry one live at a time.`);
      }
    }

    const title = validateName(b.title || videos[0].title, 'Title');
    if (!title.ok) throw new HttpError(400, title.error);
    const id = store.createSchedule({
      userId: user.id, title: title.value, videoIds: ids, startAt, loopCount: loops,
      destIds, deleteAfter: b.delete_after === undefined ? true : !!b.delete_after,
    });
    store.addActivity(user.id, 'schedule_created', `${title.value} @ ${new Date(startAt).toISOString()}`);
    send(res, 201, { schedule: scheduleView(store.getSchedule(id)) });
  });

  route('POST', '/api/schedules/:id/cancel', async (_req, res, { user, params }) => {
    const s = store.getSchedule(Number(params.id));
    if (!s || (s.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
    if (!player?.cancel(s.id)) throw new HttpError(409, 'This live is not running or scheduled any more');
    store.addActivity(user.id, 'schedule_cancelled', s.title);
    send(res, 200, { ok: true });
  });

  // ---------- admin: team ----------
  route('GET', '/api/users', async (_req, res, ctx) => {
    needSession(ctx);
    const { user } = ctx;
    needAdmin(user);
    send(res, 200, { users: store.listUsers() });
  });

  route('POST', '/api/users', async (req, res, ctx) => {
    needSession(ctx);
    const { user } = ctx;
    needAdmin(user);
    const b = await readJson(req);
    const email = validateEmail(b.email);
    const name = validateName(b.name);
    const pw = validatePassword(b.password);
    for (const v of [email, name, pw]) if (!v.ok) throw new HttpError(400, v.error);
    if (store.getUserByEmail(email.value)) throw new HttpError(409, 'Email already exists');
    const role = b.role === 'admin' ? 'admin' : 'operator';
    const id = store.createUser({ email: email.value, name: name.value, passwordHash: hashPassword(pw.value), role });
    store.addActivity(user.id, 'user_created', email.value);
    send(res, 201, { id });
  });

  route('PATCH', '/api/users/:id', async (req, res, ctx) => {
    needSession(ctx);
    const { user, params } = ctx;
    needAdmin(user);
    const target = store.getUser(Number(params.id));
    if (!target) throw new HttpError(404, 'Not found');
    const b = await readJson(req);
    const patch = {};
    if (b.active !== undefined) {
      if (target.id === user.id && !b.active) throw new HttpError(400, 'You cannot deactivate yourself');
      patch.active = !!b.active;
    }
    if (b.role !== undefined) {
      if (target.id === user.id && b.role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
      patch.role = b.role === 'admin' ? 'admin' : 'operator';
    }
    if (b.password !== undefined) { const v = validatePassword(b.password); if (!v.ok) throw new HttpError(400, v.error); patch.passwordHash = hashPassword(v.value); }
    store.updateUser(target.id, patch);
    if (patch.active === false || patch.passwordHash) store.deleteUserSessions(target.id);
    store.addActivity(user.id, 'user_updated', target.email);
    send(res, 200, { ok: true });
  });


  // ---------- events: public watch pages ----------
  const eventView = (e) => ({
    id: e.id, slug: e.slug, path: `/e/${e.slug}`, title: e.title, description: e.description, start_at: e.start_at,
    embed_type: e.embed_type, embed_ref: e.embed_ref, ask_phone: !!e.ask_phone, remind_minutes: e.remind_minutes, regs: e.regs ?? store.countRegistrations(e.id),
  });
  const ownedEvent = (user, id) => {
    const e = store.getEvent(Number(id));
    if (!e || (e.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
    return e;
  };
  const embedLink = (e) => (e.embed_type === 'youtube' ? `https://youtu.be/${e.embed_ref}` : e.embed_type === 'twitch' ? `https://twitch.tv/${e.embed_ref}` : e.embed_ref);
  route('GET', '/api/events', async (_req, res, { user }) => send(res, 200, store.listEvents(user.role === 'admin' ? null : user.id).map(eventView)));
  route('POST', '/api/events', async (req, res, { user, viaKey }) => {
    needSession({ viaKey });
    const v = validateEvent(await readJson(req));
    if (v.error) throw new HttpError(400, v.error);
    const id = store.createEvent({ userId: user.id, slug: newSlug(), ...v.value });
    store.addActivity(user.id, 'event_created', v.value.title);
    send(res, 201, eventView(store.getEvent(id)));
  });
  route('PUT', '/api/events/:id', async (req, res, { user, params }) => {
    const e = ownedEvent(user, params.id);
    const b = await readJson(req);
    const v = validateEvent({ embed_url: embedLink(e), ...b }, Date.now(), true);
    if (v.error) throw new HttpError(400, v.error);
    store.updateEvent(e.id, v.value);
    send(res, 200, eventView(store.getEvent(e.id)));
  });
  route('DELETE', '/api/events/:id', async (_req, res, { user, params }) => {
    const e = ownedEvent(user, params.id);
    store.deleteEvent(e.id);
    store.addActivity(user.id, 'event_deleted', e.title);
    send(res, 200, { ok: true });
  });
  route('GET', '/api/events/:id/registrations', async (_req, res, { user, params }) => {
    const e = ownedEvent(user, params.id);
    send(res, 200, store.listRegistrations(e.id));
  });
  route('GET', '/api/events/:id/registrations.csv', async (_req, res, { user, params }) => {
    const e = ownedEvent(user, params.id);
    const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    const rows = [['Name', 'Email', 'Phone', 'Registered at'], ...store.listRegistrations(e.id).map((r) => [r.name, r.email, r.phone, new Date(r.created_at).toISOString()])];
    send(res, 200, rows.map((r) => r.map(cell).join(',')).join('\n'), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="registrations-${e.slug}.csv"` });
  }, {});

  // Admin-only copy of the database (settings, channels, destinations, users). Keep it private: it is only readable with your APP_SECRET.
  route('GET', '/api/backup', async (_req, res, ctx) => {
    needSession(ctx); needAdmin(ctx.user);
    const tmp = path.join(os.tmpdir(), `vs-backup-${crypto.randomUUID()}.db`);
    try {
      store.backupTo(tmp);
      const data = fs.readFileSync(tmp);
      store.addActivity(ctx.user.id, 'backup_downloaded');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="vivid-stream-${new Date().toISOString().slice(0, 10)}.db"`, 'cache-control': 'no-store', 'content-length': data.length });
      res.end(data);
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  // "Add to calendar" for an event page.
  route('GET', '/api/public/event/:slug/calendar.ics', async (req, res, { params }) => {
    const e = store.getEventBySlug(params.slug);
    if (!e) throw new HttpError(404, 'Event not found');
    const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (t) => String(t).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
    const url = `${cfg.publicBaseUrl || `http://${req.headers.host}`}/e/${e.slug}`;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vivid Stream//EN', 'BEGIN:VEVENT', `UID:${e.slug}@vivid-stream`, `DTSTAMP:${fmt(Date.now())}`,
      `DTSTART:${fmt(e.start_at)}`, `DTEND:${fmt(e.start_at + 3600000)}`, `SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(`${e.description}\n${url}`.trim())}`, `URL:${url}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Live starts soon', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    send(res, 200, ics, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${e.slug}.ics"` });
  }, { auth: false });

  route('GET', '/api/public/event/:slug', async (req, res, { params }) => {
    const e = store.getEventBySlug(params.slug);
    if (!e) throw new HttpError(404, 'Event not found');
    const now = Date.now();
    const open = now >= e.start_at - 10 * 60000; // the player address is only handed out near the start time
    send(res, 200, {
      title: e.title, description: e.description, start_at: e.start_at, now, ask_phone: !!e.ask_phone,
      embed: open ? embedUrl(e.embed_type, e.embed_ref, String(req.headers.host || 'localhost')) : '',
    });
  }, { auth: false });
  route('POST', '/api/public/event/:slug/register', async (req, res, { params }) => {
    const e = store.getEventBySlug(params.slug);
    if (!e) throw new HttpError(404, 'Event not found');
    const ip = clientIp(req); const now = Date.now();
    const h = (regHits.get(ip) || []).filter((t) => now - t < 3600000);
    if (h.length >= 20) throw new HttpError(429, 'Too many registrations. Try later.');
    regHits.set(ip, [...h, now]);
    const b = await readJson(req);
    const name = clean(b.name, 80);
    if (!name) throw new HttpError(400, 'Please enter your name');
    const email = clean(b.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email looks wrong');
    const phone = clean(b.phone, 20).replace(/[\s()-]/g, '');
    if (phone && !/^\+?\d{8,15}$/.test(phone)) throw new HttpError(400, 'Phone number looks wrong');
    if (!email && !phone) throw new HttpError(400, 'Please enter your email or phone');
    if (store.hasRegistration(e.id, email, phone)) return send(res, 200, { ok: true, already: true });
    if (store.countRegistrations(e.id) >= 5000) throw new HttpError(400, 'Registrations are full');
    store.addRegistration({ eventId: e.id, name, email, phone });
    send(res, 201, { ok: true });
  }, { auth: false });

  // ---------- static files ----------
  const serveStatic = (req, res) => {
    const urlPath = new URL(req.url, 'http://x').pathname;
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, { error: 'Not found' });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('vendor/') ? 'public, max-age=86400' : 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  // ---------- dispatcher ----------
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      if ((req.method === 'GET' || req.method === 'HEAD') && /^\/e\/[a-z0-9]{3,20}$/.test(pathname)) {
        // Public event page: may embed YouTube / Twitch / Facebook players.
        res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-src https://www.youtube.com https://player.twitch.tv https://www.facebook.com; frame-ancestors 'none'");
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(PUBLIC_DIR, 'watch.html')).pipe(res);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && !pathname.startsWith('/internal/') && pathname !== '/healthz') {
        return serveStatic(req, res);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) return send(res, 404, { error: 'Not found' });
      const params = {};
      const m = r.re.exec(pathname);
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      // Programs (e.g. Vividora) authenticate with "Authorization: Bearer vs_..."; browsers use the cookie.
      const authHeader = String(req.headers.authorization || '');
      const viaKey = /^Bearer vs_[0-9a-f]{40}$/.test(authHeader);
      // Cookie-authenticated writes need a custom header, which blocks cross-site form posts (CSRF).
      if (r.csrf !== false && req.method !== 'GET' && !viaKey && req.headers['x-requested-with'] !== 'vivid') {
        throw new HttpError(403, 'Missing X-Requested-With header');
      }
      let user = null;
      if (r.auth !== false) {
        user = viaKey ? store.getUserByApiKeyHash(sha256(authHeader.slice(7))) : store.getSessionUser(parseCookies(req).sid);
        if (!user) throw new HttpError(401, viaKey ? 'Invalid API key' : 'Please log in');
      }
      await r.handler(req, res, { user, params, viaKey });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log.error('request failed', e);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    }
  });

  server.studio = attachStudio(server, { store, relay, cfg, spawn, parseCookies, log });
  guestsApi = server.guests = attachGuests(server, { store, parseCookies, log });
  server.on('upgrade', (req, socket) => { // nobody claimed it
    if (!req.wsHandled) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  return server;
}

// ---------- bootstrap ----------
export function seedAdmin(store, cfg, log = console) {
  if (store.countUsers() > 0) return;
  if (cfg.adminEmail && cfg.adminPassword) {
    store.createUser({
      email: cfg.adminEmail, name: 'Admin',
      passwordHash: hashPassword(cfg.adminPassword), role: 'admin',
    });
    log.info(`Created first admin: ${cfg.adminEmail}`);
  } else {
    log.warn('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, or run: npm run create-user -- you@example.com "Your Name" "password" admin');
  }
}

async function main() {
  const cfg = loadConfig();
  const store = openDb(cfg.dataDir);
  const vault = makeVault(cfg.secret);
  const internalToken = randomToken(16);
  seedAdmin(store, cfg);

  const notifier = new Notifier({ cfg, store });
  let standby = null;
  const relayEvents = relayEventHandler({ store, notifier });
  const relay = new RelayManager({
    store, vault, cfg, internalToken, onEvent: (ev) => { relayEvents(ev); standby?.handle(ev); },
  });
  standby = new Standby({ store, relay, cfg, dataDir: cfg.dataDir, onEvent: standbyEventHandler({ store, notifier }) });
  const processor = new VideoProcessor({ store, cfg });
  const player = new SchedulePlayer({
    store, cfg, relay, notifier, dataDir: cfg.dataDir, onEvent: playerEventHandler({ store, notifier }),
  });
  const recorder = new Recorder({ store, cfg, relay, internalToken, onEvent: recorderEventHandler({ store }) });
  const server = createApp({ cfg, store, relay, internalToken, processor, player, standby, oauth: makeOAuth({ cfg, store, vault }) });
  server.listen(cfg.port, cfg.host, () => console.log(`vivid-stream listening on ${cfg.host}:${cfg.port}`));
  relay.start();
  player.start();
  processor.resume();
  recorder.start();
  const reminders = new EventReminders({ store, notifier, baseUrl: cfg.publicBaseUrl });
  reminders.start();

  const housekeeping = () => {
    store.purgeSessions();
    store.trimActivity();
    recorder.purgeOld();
    try {
      const st = fs.statfsSync(cfg.dataDir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < cfg.diskReserveBytes * 1.5) {
        notifier.send(null, `💾 सर्वर की डिस्क भर रही है: सिर्फ़ ${(free / 1024 ** 3).toFixed(1)} GB खाली. पुराने वीडियो/रिकॉर्डिंग हटाइए.`, { key: 'disk-low' }).catch(() => {});
      }
    } catch { /* statfs unavailable */ }
    // Unfinished uploads and failed files older than a day are removed to free disk space.
    for (const v of store.listStaleUploads('-1 day')) {
      fs.rmSync(v.file_path, { force: true });
      fs.rmSync(`${v.file_path}.conv.mp4`, { force: true });
      store.deleteVideo(v.id);
    }
  };
  housekeeping();
  const housekeepingTimer = setInterval(housekeeping, 3600 * 1000);
  const shutdown = async () => {
    clearInterval(housekeepingTimer);
    server.studio?.stopAll();
    standby.shutdown();
    player.shutdown();
    recorder.shutdown();
    reminders.stop();
    processor.shutdown();
    await relay.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
