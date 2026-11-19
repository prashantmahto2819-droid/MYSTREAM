import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { makeVault } from '../src/crypto.js';
import { Standby, buildStandbyArgs } from '../src/standby.js';
import { standbyEventHandler } from '../src/alerts.js';

function setup({ standby = true } = {}) {
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'Asha', passwordHash: 'h' });
  store.updateUser(uid, { standby, standbyMinutes: 1, standbyText: 'Back soon' });
  store.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('kkkk1') });
  const user = store.getUser(uid);
  const relay = { filters: new Map(), expected: [], live: new Set(),
    setFilter(k, ids) { if (ids) this.filters.set(k, new Set(ids)); else this.filters.delete(k); },
    noteExpectedDrop(k) { this.expected.push(k); }, isIngestLive(k) { return this.live.has(k); } };
  const procs = []; const events = [];
  const sb = new Standby({ store, relay, cfg: { mediamtxRtmp: 'rtmp://m:1935', ffmpegBin: 'ffmpeg' }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')),
    onEvent: (e) => events.push(e),
    spawn: (bin, args) => { const p = new EventEmitter(); p.args = args; p.stderr = new EventEmitter(); p.kill = () => setImmediate(() => p.emit('close', null)); procs.push(p); return p; } });
  return { store, uid, user, relay, sb, procs, events };
}

test('standby args publish a silent slate on the ingest key, limited in time', () => {
  const a = buildStandbyArgs({ output: 'rtmp://m/live/k', maxSeconds: 600 });
  assert.equal(a.at(-1), 'rtmp://m/live/k');
  assert.equal(a[a.indexOf('-t') + 1], '600');
  assert.ok(a.includes('anullsrc=r=44100:cl=stereo'));
  assert.ok(buildStandbyArgs({ output: 'o', maxSeconds: 1, textFile: '/t.txt', fontFile: '/f.ttf' }).join(' ').includes('drawtext'));
});

test('standby starts when OBS drops (if enabled), keeps destinations, ends when OBS is back', () => {
  const t = setup();
  t.sb.handle({ type: 'ingest_started', userId: t.uid });
  assert.equal(t.procs.length, 0);
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  assert.equal(t.procs.length, 1);
  assert.ok(t.procs[0].args.includes(`rtmp://m:1935/live/${t.user.ingest_key}`));
  assert.ok(t.relay.filters.has(t.user.ingest_key));
  assert.equal(t.sb.isActive(t.uid), true);
  assert.equal(t.events[0].type, 'standby_started');
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  assert.equal(t.procs.length, 1, 'only one slate per user');

  // OBS reconnects and takes the key: ffmpeg is kicked out
  t.relay.live.add(t.user.ingest_key);
  t.procs[0].emit('close', 1);
  assert.equal(t.events.at(-1).type, 'standby_ended');
  assert.equal(t.relay.filters.size, 0);
  assert.equal(t.sb.isActive(t.uid), false);
});

test('standby: off by default, manual stop, timeout, failure', async () => {
  let t = setup({ standby: false });
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  assert.equal(t.procs.length, 0);

  t = setup();
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  assert.equal(t.sb.stop(t.uid), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.events.at(-1).type, 'standby_stopped');
  assert.deepEqual(t.relay.expected, [t.user.ingest_key], 'stopping on purpose is not a dropped-stream alert');

  t = setup();
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  t.sb.stop(t.uid, true); // timeout path
  await new Promise((r) => setImmediate(r));
  assert.equal(t.events.at(-1).type, 'standby_timeout');

  t = setup();
  t.sb.handle({ type: 'ingest_dropped', userId: t.uid });
  t.procs[0].stderr.emit('data', Buffer.from('Connection refused\n'));
  t.procs[0].emit('close', 1);
  assert.equal(t.events.at(-1).type, 'standby_failed');
  assert.match(t.events.at(-1).detail, /refused/);
});

test('standby alerts: Hindi text and activity log', () => {
  const t = setup(); const sent = [];
  const h = standbyEventHandler({ store: t.store, notifier: { send: async (u, m) => sent.push(m) } });
  h({ type: 'standby_started', userId: t.uid, name: 'Asha', detail: '10' });
  h({ type: 'standby_timeout', userId: t.uid, name: 'Asha' });
  assert.equal(sent.length, 2);
  assert.match(sent[0], /स्टैंडबाय/);
  assert.ok(t.store.listActivity(t.uid).some((a) => a.action === 'standby_started'));
});
