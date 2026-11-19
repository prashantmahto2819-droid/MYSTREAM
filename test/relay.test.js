import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { makeVault } from '../src/crypto.js';
import { RelayManager } from '../src/relay.js';

const cfg = {
  mediamtxApi: 'http://mtx', mediamtxRtmp: 'rtmp://mtx:1935', ffmpegBin: 'ffmpeg',
  pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const user = store.getUser(uid);
  const mk = (name, key) => store.createDestination({
    userId: uid, name, platform: 'custom', rtmpUrl: 'rtmp://a.example.com/live', keyEnc: vault.encrypt(key),
  });
  const d1 = mk('one', 'KEY-ONE-1111');
  const d2 = mk('two', 'KEY-TWO-2222');

  const live = new Set();
  let apiDown = false;
  const fetchImpl = async () => {
    if (apiDown) throw new Error('down');
    return { ok: true, json: async () => ({ items: [...live].map((k) => ({ name: `live/${k}`, ready: true })) }) };
  };
  const procs = [];
  const spawn = (bin, args) => {
    const p = new EventEmitter();
    p.args = args; p.killed = false;
    p.stderr = new EventEmitter();
    p.kill = (sig) => { p.killed = sig; setImmediate(() => p.emit('close', null, sig)); };
    procs.push(p);
    return p;
  };
  const events = [];
  const relay = new RelayManager({
    store, vault, cfg, internalToken: 'TOKEN1234', spawn, fetchImpl,
    log: { error() {}, warn() {}, info() {} }, onEvent: (e) => events.push(e),
  });
  return { store, user, d1, d2, live, relay, procs, events, setApiDown: (v) => { apiDown = v; } };
}

test('starts one ffmpeg per enabled destination when ingest goes live, stops when it drops', async () => {
  const t = setup();
  t.store.updateDestination(t.d2, { enabled: false });
  await t.relay.tick();
  assert.equal(t.procs.length, 0, 'nothing before OBS connects');

  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  assert.equal(t.procs.length, 1);
  const args = t.procs[0].args;
  assert.ok(args.includes('copy'));
  assert.ok(args.some((a) => a.startsWith('rtmp://mtx:1935/live/') && a.includes('token=TOKEN1234')));
  assert.ok(args.includes('rtmp://a.example.com/live/KEY-ONE-1111'));

  t.store.updateDestination(t.d2, { enabled: true });
  await t.relay.tick();
  assert.equal(t.procs.length, 2, 'enabling a destination mid-stream starts it');
  await sleep(60);
  assert.equal(t.relay.statusFor(t.d1).status, 'live');

  t.store.updateDestination(t.d1, { enabled: false });
  await t.relay.tick();
  assert.equal(t.procs[0].killed, 'SIGTERM');
  assert.equal(t.relay.statusFor(t.d1).status, 'idle');
  assert.equal(t.relay.statusFor(t.d2).status, 'live');

  t.live.clear();
  await t.relay.tick();
  assert.equal(t.procs[1].killed, 'SIGTERM');
  assert.equal(t.relay.statusFor(t.d2).status, 'idle');
  await t.relay.shutdown();
});

test('a crashing destination restarts with backoff and does not affect the other; keys are masked in errors', async () => {
  const t = setup();
  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  assert.equal(t.procs.length, 2);
  const [p1] = t.procs;
  p1.stderr.emit('data', Buffer.from('Connection to rtmp://a.example.com/live/KEY-ONE-1111 refused\n'));
  p1.emit('close', 1, null);

  assert.equal(t.relay.statusFor(t.d1).status, 'error');
  assert.ok(!t.relay.statusFor(t.d1).error.includes('KEY-ONE-1111'), 'stream key leaked in error text');
  assert.ok(t.relay.statusFor(t.d1).error.includes('***'));
  await sleep(60);
  assert.equal(t.procs.length, 3, 'restarted after backoff');
  assert.equal(t.relay.statusFor(t.d1).restarts, 1);
  assert.notEqual(t.relay.statusFor(t.d2).status, 'error');
  assert.ok(t.events.some((e) => e.type === 'error' && !e.detail.includes('KEY-ONE-1111')));
  await t.relay.shutdown();
});

test('if the MediaMTX API is unreachable, running relays are left alone', async () => {
  const t = setup();
  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  t.setApiDown(true);
  await t.relay.tick();
  assert.equal(t.procs.filter((p) => p.killed).length, 0);
  assert.equal(t.relay.apiOk, false);
  await t.relay.shutdown();
});

test('changing a destination key restarts its relay with the new key', async () => {
  const t = setup();
  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  const vault = makeVault('s'.repeat(20));
  t.store.updateDestination(t.d1, { keyEnc: vault.encrypt('NEW-KEY-9999') });
  await t.relay.tick();
  await t.relay.tick();
  assert.ok(t.procs.some((p) => p.args.includes('rtmp://a.example.com/live/NEW-KEY-9999')));
  await t.relay.shutdown();
});
