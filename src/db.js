import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomToken, sha256 } from './crypto.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator')),
  ingest_key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'custom',
  rtmp_url TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  expected_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','ready','failed')),
  error TEXT,
  duration REAL, width INTEGER, height INTEGER, fps REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  video_ids TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  loop_count INTEGER NOT NULL DEFAULT 1,
  dest_ids TEXT,
  delete_after INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','running','done','failed','missed','cancelled')),
  error TEXT,
  started_at INTEGER, ended_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','done')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  embed_type TEXT NOT NULL DEFAULT '',
  embed_ref TEXT NOT NULL DEFAULT '',
  ask_phone INTEGER NOT NULL DEFAULT 0,
  remind_minutes INTEGER NOT NULL DEFAULT 15,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(dir) {
  let file = ':memory:';
  if (dir !== ':memory:') {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'vivid-stream.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Small migration: users.phone (WhatsApp alerts) was added after the first release.
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('record')) db.exec('ALTER TABLE users ADD COLUMN record INTEGER NOT NULL DEFAULT 0');
  const dcols = db.prepare('PRAGMA table_info(destinations)').all().map((c) => c.name);
  if (!dcols.includes('group_name')) db.exec("ALTER TABLE destinations ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('standby')) db.exec('ALTER TABLE users ADD COLUMN standby INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('standby_text')) db.exec("ALTER TABLE users ADD COLUMN standby_text TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('standby_minutes')) db.exec('ALTER TABLE users ADD COLUMN standby_minutes INTEGER NOT NULL DEFAULT 10');
  db.exec(`CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google','facebook','twitch')),
    remote_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    token_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    UNIQUE (user_id, provider, remote_id)
  )`);
  const connSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'connections'").get()?.sql || '';
  if (connSql && !connSql.includes("'twitch'")) {
    db.exec('ALTER TABLE connections RENAME TO connections_old');
    db.exec(`CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('google','facebook','twitch')),
      remote_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      UNIQUE (user_id, provider, remote_id)
    )`);
    db.exec('INSERT INTO connections SELECT id,user_id,provider,remote_id,account_name,token_enc,created_at FROM connections_old');
    db.exec('DROP TABLE connections_old');
  }
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return makeStore(db);
}

function parseSchedule(row) {
  if (!row) return row;
  return { ...row, video_ids: JSON.parse(row.video_ids), dest_ids: row.dest_ids ? JSON.parse(row.dest_ids) : null };
}

function makeStore(db) {
  const q = (sql) => db.prepare(sql);
  return {
    raw: db,

    // ---- users ----
    countUsers: () => q('SELECT COUNT(*) AS n FROM users').get().n,
    createUser({ email, name, passwordHash, role = 'operator' }) {
      const r = q(
        'INSERT INTO users (email, name, password_hash, role, ingest_key) VALUES (?,?,?,?,?)'
      ).run(email.toLowerCase(), name, passwordHash, role, randomToken(12));
      return Number(r.lastInsertRowid);
    },
    getUser: (id) => q('SELECT * FROM users WHERE id = ?').get(id),
    getUserByEmail: (email) => q('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()),
    getUserByIngestKey: (key) => q('SELECT * FROM users WHERE ingest_key = ?').get(key),
    listUsers: () => q('SELECT id,email,name,role,active,phone,created_at FROM users ORDER BY id').all(),
    updateUser(id, f) {
      if (f.phone !== undefined) q('UPDATE users SET phone=? WHERE id=?').run(f.phone, id);
      if (f.record !== undefined) q('UPDATE users SET record=? WHERE id=?').run(f.record ? 1 : 0, id);
      if (f.standby !== undefined) q('UPDATE users SET standby=? WHERE id=?').run(f.standby ? 1 : 0, id);
      if (f.standbyText !== undefined) q('UPDATE users SET standby_text=? WHERE id=?').run(f.standbyText, id);
      if (f.standbyMinutes !== undefined) q('UPDATE users SET standby_minutes=? WHERE id=?').run(f.standbyMinutes, id);
      if (f.role !== undefined) q('UPDATE users SET role=? WHERE id=?').run(f.role, id);
      if (f.active !== undefined) q('UPDATE users SET active=? WHERE id=?').run(f.active ? 1 : 0, id);
      if (f.passwordHash !== undefined) q('UPDATE users SET password_hash=? WHERE id=?').run(f.passwordHash, id);
      if (f.name !== undefined) q('UPDATE users SET name=? WHERE id=?').run(f.name, id);
    },
    rotateIngestKey(id) {
      const key = randomToken(12);
      q('UPDATE users SET ingest_key=? WHERE id=?').run(key, id);
      return key;
    },

    // ---- sessions ----
    createSession(userId, ttlMs) {
      const token = randomToken(32);
      q('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(
        sha256(token), userId, Date.now() + ttlMs
      );
      return token;
    },
    getSessionUser(token) {
      if (!token) return null;
      const row = q(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
      ).get(sha256(token), Date.now());
      return row || null;
    },
    deleteSession: (token) => q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)),
    deleteUserSessions: (userId) => q('DELETE FROM sessions WHERE user_id = ?').run(userId),
    purgeSessions: () => q('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()),

    // ---- destinations ----
    listDestinations: (userId) =>
      q('SELECT * FROM destinations WHERE user_id = ? ORDER BY id').all(userId),
    listAllDestinations: () => q('SELECT * FROM destinations ORDER BY id').all(),
    listEnabledDestinations: (userId) =>
      q('SELECT * FROM destinations WHERE user_id = ? AND enabled = 1 ORDER BY id').all(userId),
    countDestinations: (userId) =>
      q('SELECT COUNT(*) AS n FROM destinations WHERE user_id = ?').get(userId).n,
    getDestination: (id) => q('SELECT * FROM destinations WHERE id = ?').get(id),
    createDestination({ userId, name, platform, rtmpUrl, keyEnc }) {
      const r = q(
        'INSERT INTO destinations (user_id,name,platform,rtmp_url,key_enc) VALUES (?,?,?,?,?)'
      ).run(userId, name, platform, rtmpUrl, keyEnc);
      return Number(r.lastInsertRowid);
    },
    updateDestination(id, f) {
      if (f.name !== undefined) q('UPDATE destinations SET name=? WHERE id=?').run(f.name, id);
      if (f.platform !== undefined) q('UPDATE destinations SET platform=? WHERE id=?').run(f.platform, id);
      if (f.rtmpUrl !== undefined) q('UPDATE destinations SET rtmp_url=? WHERE id=?').run(f.rtmpUrl, id);
      if (f.keyEnc !== undefined) q('UPDATE destinations SET key_enc=? WHERE id=?').run(f.keyEnc, id);
      if (f.groupName !== undefined) q('UPDATE destinations SET group_name=? WHERE id=?').run(f.groupName, id);
      if (f.enabled !== undefined) q('UPDATE destinations SET enabled=? WHERE id=?').run(f.enabled ? 1 : 0, id);
    },
    deleteDestination: (id) => q('DELETE FROM destinations WHERE id = ?').run(id),

    // ---- videos ----
    createVideo({ userId, title, filePath, ext, expectedSize }) {
      const r = q('INSERT INTO videos (user_id,title,file_path,ext,expected_size) VALUES (?,?,?,?,?)')
        .run(userId, title, filePath, ext, expectedSize);
      return Number(r.lastInsertRowid);
    },
    getVideo: (id) => q('SELECT * FROM videos WHERE id = ?').get(id),
    listVideos: (userId) => (userId == null
      ? q('SELECT * FROM videos ORDER BY id DESC').all()
      : q('SELECT * FROM videos WHERE user_id = ? ORDER BY id DESC').all(userId)),
    updateVideo(id, f) {
      const map = { size: 'size', status: 'status', error: 'error', duration: 'duration', width: 'width',
        height: 'height', fps: 'fps', filePath: 'file_path', ext: 'ext' };
      for (const [k, col] of Object.entries(map)) {
        if (f[k] !== undefined) q(`UPDATE videos SET ${col}=? WHERE id=?`).run(f[k], id);
      }
    },
    deleteVideo: (id) => q('DELETE FROM videos WHERE id = ?').run(id),
    // Unfinished uploads count at their full promised size so several big uploads cannot slip past the quota.
    // Recordings of lives count too.
    storageUsed: (userId) => q(
      "SELECT COALESCE(SUM(CASE WHEN status = 'ready' THEN size ELSE expected_size END),0) AS n FROM videos WHERE user_id = ? AND status != 'failed'"
    ).get(userId).n + q('SELECT COALESCE(SUM(size),0) AS n FROM recordings WHERE user_id = ?').get(userId).n,
    listStaleUploads: (olderThanSql) =>
      q("SELECT * FROM videos WHERE status IN ('uploading','failed') AND created_at < datetime('now', ?)").all(olderThanSql),

    // ---- schedules ----
    createSchedule({ userId, title, videoIds, startAt, loopCount, destIds, deleteAfter }) {
      const r = q(`INSERT INTO schedules (user_id,title,video_ids,start_at,loop_count,dest_ids,delete_after)
                   VALUES (?,?,?,?,?,?,?)`).run(userId, title, JSON.stringify(videoIds), startAt, loopCount,
        destIds ? JSON.stringify(destIds) : null, deleteAfter ? 1 : 0);
      return Number(r.lastInsertRowid);
    },
    getSchedule: (id) => parseSchedule(q('SELECT * FROM schedules WHERE id = ?').get(id)),
    listSchedules: (userId, limit = 100) => (userId == null
      ? q('SELECT * FROM schedules ORDER BY start_at DESC LIMIT ?').all(limit)
      : q('SELECT * FROM schedules WHERE user_id = ? ORDER BY start_at DESC LIMIT ?').all(userId, limit)).map(parseSchedule),
    listActiveSchedules: (userId) => q(
      "SELECT * FROM schedules WHERE status IN ('scheduled','running') AND user_id = ?").all(userId).map(parseSchedule),
    listAllActiveSchedules: () => q("SELECT * FROM schedules WHERE status IN ('scheduled','running')").all().map(parseSchedule),
    listDueSchedules: (now) => q("SELECT * FROM schedules WHERE status = 'scheduled' AND start_at <= ? ORDER BY start_at").all(now).map(parseSchedule),
    updateSchedule(id, f) {
      const map = { status: 'status', error: 'error', startedAt: 'started_at', endedAt: 'ended_at' };
      for (const [k, col] of Object.entries(map)) {
        if (f[k] !== undefined) q(`UPDATE schedules SET ${col}=? WHERE id=?`).run(f[k], id);
      }
    },
    videoInUse(videoId) {
      return q("SELECT * FROM schedules WHERE status IN ('scheduled','running')").all()
        .map(parseSchedule).some((s) => s.video_ids.includes(videoId));
    },

    // ---- API keys ----
    createApiKey({ userId, name, tokenHash, prefix }) {
      const r = q('INSERT INTO api_keys (user_id,name,token_hash,prefix) VALUES (?,?,?,?)').run(userId, name, tokenHash, prefix);
      return Number(r.lastInsertRowid);
    },
    listApiKeys: (userId) => q('SELECT id,name,prefix,created_at,last_used_at FROM api_keys WHERE user_id = ? ORDER BY id').all(userId),
    deleteApiKey: (id, userId) => q('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId).changes,
    getUserByApiKeyHash(hash) {
      const row = q(`SELECT u.*, k.id AS key_id, k.last_used_at AS key_last_used FROM api_keys k
                     JOIN users u ON u.id = k.user_id WHERE k.token_hash = ? AND u.active = 1`).get(hash);
      if (row && (!row.key_last_used || Date.now() - row.key_last_used > 60000)) {
        q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.key_id);
      }
      return row || null;
    },

    // ---- connected accounts (YouTube / Facebook pages) ----
    upsertConnection({ userId, provider, remoteId, accountName, tokenEnc }) {
      const old = q('SELECT id FROM connections WHERE user_id=? AND provider=? AND remote_id=?').get(userId, provider, remoteId);
      if (old) { q('UPDATE connections SET account_name=?, token_enc=? WHERE id=?').run(accountName, tokenEnc, old.id); return old.id; }
      return Number(q('INSERT INTO connections (user_id,provider,remote_id,account_name,token_enc) VALUES (?,?,?,?,?)').run(userId, provider, remoteId, accountName, tokenEnc).lastInsertRowid);
    },
    listConnections: (userId) => q('SELECT id,user_id,provider,remote_id,account_name,created_at FROM connections WHERE user_id = ? ORDER BY id').all(userId),
    getConnection: (id) => q('SELECT * FROM connections WHERE id = ?').get(id),
    updateConnectionToken: (id, tokenEnc) => q('UPDATE connections SET token_enc=? WHERE id=?').run(tokenEnc, id),
    deleteConnection: (id) => q('DELETE FROM connections WHERE id = ?').run(id),

    // ---- recordings ----
    createRecording({ userId, title, filePath, startedAt }) {
      const r = q('INSERT INTO recordings (user_id,title,file_path,started_at) VALUES (?,?,?,?)').run(userId, title, filePath, startedAt);
      return Number(r.lastInsertRowid);
    },
    getRecording: (id) => q('SELECT * FROM recordings WHERE id = ?').get(id),
    listRecordings: (userId) => (userId == null
      ? q('SELECT * FROM recordings ORDER BY id DESC LIMIT 200').all()
      : q('SELECT * FROM recordings WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId)),
    updateRecording(id, f) {
      if (f.size !== undefined) q('UPDATE recordings SET size=? WHERE id=?').run(f.size, id);
      if (f.status !== undefined) q('UPDATE recordings SET status=? WHERE id=?').run(f.status, id);
      if (f.endedAt !== undefined) q('UPDATE recordings SET ended_at=? WHERE id=?').run(f.endedAt, id);
    },
    deleteRecording: (id) => q('DELETE FROM recordings WHERE id = ?').run(id),
    listOpenRecordings: () => q("SELECT * FROM recordings WHERE status = 'recording'").all(),
    listOldRecordings: (olderThanMs) => q("SELECT * FROM recordings WHERE status = 'done' AND ended_at < ?").all(olderThanMs),

    // ---- events (public watch pages) ----
    createEvent({ userId, slug, title, description, startAt, embedType, embedRef, askPhone, remindMinutes }) {
      const r = q(`INSERT INTO events (user_id,slug,title,description,start_at,embed_type,embed_ref,ask_phone,remind_minutes)
                   VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, slug, title, description, startAt, embedType, embedRef, askPhone, remindMinutes);
      return Number(r.lastInsertRowid);
    },
    getEvent: (id) => q('SELECT * FROM events WHERE id = ?').get(id),
    getEventBySlug: (slug) => q('SELECT * FROM events WHERE slug = ?').get(slug),
    listEvents: (userId) => (userId == null
      ? q('SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS regs FROM events e ORDER BY start_at DESC LIMIT 100').all()
      : q('SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS regs FROM events e WHERE user_id = ? ORDER BY start_at DESC LIMIT 100').all(userId)),
    updateEvent(id, f) {
      q(`UPDATE events SET title=?, description=?, start_at=?, embed_type=?, embed_ref=?, ask_phone=?, remind_minutes=?, reminded=0 WHERE id=?`)
        .run(f.title, f.description, f.startAt, f.embedType, f.embedRef, f.askPhone, f.remindMinutes, id);
    },
    deleteEvent: (id) => q('DELETE FROM events WHERE id = ?').run(id),
    listEventsToRemind: (now) => q('SELECT * FROM events WHERE reminded = 0 AND start_at > ? AND start_at - remind_minutes * 60000 <= ?').all(now, now),
    markEventReminded: (id) => q('UPDATE events SET reminded = 1 WHERE id = ?').run(id),
    addRegistration: ({ eventId, name, email, phone }) => Number(q('INSERT INTO registrations (event_id,name,email,phone) VALUES (?,?,?,?)').run(eventId, name, email, phone).lastInsertRowid),
    countRegistrations: (eventId) => q('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId).n,
    hasRegistration: (eventId, email, phone) => !!q('SELECT 1 FROM registrations WHERE event_id = ? AND ((? != \'\' AND email = ?) OR (? != \'\' AND phone = ?))').get(eventId, email, email, phone, phone),
    listRegistrations: (eventId) => q('SELECT id,name,email,phone,created_at FROM registrations WHERE event_id = ? ORDER BY id').all(eventId),

    getSetting: (key) => q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
    setSetting: (key, value) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value),
    deleteSetting: (key) => q('DELETE FROM settings WHERE key = ?').run(key),

    // ---- activity log ----
    addActivity(userId, action, detail = '') {
      q('INSERT INTO activity (user_id,action,detail) VALUES (?,?,?)').run(userId ?? null, action, detail);
    },
    listActivity(userId, limit = 100) {
      const sql = `SELECT a.id, a.ts, a.action, a.detail, u.name AS user_name
                   FROM activity a LEFT JOIN users u ON u.id = a.user_id`;
      return userId == null
        ? q(`${sql} ORDER BY a.id DESC LIMIT ?`).all(limit)
        : q(`${sql} WHERE a.user_id = ? ORDER BY a.id DESC LIMIT ?`).all(userId, limit);
    },
    activitySince(userId, days = 14) {
      const sql = "SELECT ts, action, detail FROM activity WHERE ts >= datetime('now', ?) AND action IN ('studio_started','studio_stopped','obs_live_started','live_summary')";
      const since = `-${Number(days) + 1} days`;
      return userId == null ? q(sql).all(since) : q(`${sql} AND user_id = ?`).all(since, userId);
    },
    trimActivity: (keep = 5000) =>
      q('DELETE FROM activity WHERE id <= (SELECT COALESCE(MAX(id),0) - ? FROM activity)').run(keep),

    close: () => db.close(),
  };
}
