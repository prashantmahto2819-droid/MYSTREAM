import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, hashPassword, verifyPassword } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { validateRtmpUrl, validateStreamKey } from '../src/validate.js';
import { buildArgs, joinUrl, maskSecrets } from '../src/relay.js';

test('vault encrypts and decrypts, ciphertext differs each time', () => {
  const v = makeVault('x'.repeat(20));
  const a = v.encrypt('secret-key-123');
  const b = v.encrypt('secret-key-123');
  assert.notEqual(a, b);
  assert.ok(!a.includes('secret-key'));
  assert.equal(v.decrypt(a), 'secret-key-123');
  assert.throws(() => makeVault('y'.repeat(20)).decrypt(a));
});

test('password hashing', () => {
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('rtmp url validation', () => {
  assert.ok(validateRtmpUrl('rtmp://a.rtmp.youtube.com/live2').ok);
  assert.ok(validateRtmpUrl('rtmps://live-api-s.facebook.com:443/rtmp/').ok);
  for (const bad of ['http://x.com/live', 'rtmp://localhost/live', 'rtmp://mediamtx:1935/live/x',
    'rtmp://127.0.0.1/live', 'rtmp://10.0.0.5/live', 'rtmp://192.168.1.2/a', 'rtmp://[::1]/a',
    'rtmp://user:pw@a.example.com/live', 'rtmp://a.example.com/live -f x', '', 'not a url']) {
    assert.equal(validateRtmpUrl(bad).ok, false, bad);
  }
  assert.equal(validateStreamKey('abcd-1234').ok, true);
  assert.equal(validateStreamKey('ab cd').ok, false);
  assert.equal(validateStreamKey('ab\ncd').ok, false);
});

test('db: users, sessions, destinations, cascade', () => {
  const s = openDb(':memory:');
  const uid = s.createUser({ email: 'A@x.com', name: 'A', passwordHash: 'h', role: 'admin' });
  assert.equal(s.getUserByEmail('a@x.com').id, uid);
  const u = s.getUser(uid);
  assert.match(u.ingest_key, /^[0-9a-f]{24}$/);
  assert.equal(s.getUserByIngestKey(u.ingest_key).id, uid);

  const tok = s.createSession(uid, 60_000);
  assert.equal(s.getSessionUser(tok).id, uid);
  s.updateUser(uid, { active: false });
  assert.equal(s.getSessionUser(tok), null);
  s.updateUser(uid, { active: true });
  s.deleteSession(tok);
  assert.equal(s.getSessionUser(tok), null);
  const expired = s.createSession(uid, -1000);
  assert.equal(s.getSessionUser(expired), null);

  const did = s.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: 'enc' });
  assert.equal(s.listEnabledDestinations(uid).length, 1);
  s.updateDestination(did, { enabled: false });
  assert.equal(s.listEnabledDestinations(uid).length, 0);
  const newKey = s.rotateIngestKey(uid);
  assert.notEqual(newKey, u.ingest_key);
  assert.equal(s.getUserByIngestKey(u.ingest_key), undefined);
});

test('relay helpers', () => {
  assert.equal(joinUrl('rtmp://a/live2/', 'KEY'), 'rtmp://a/live2/KEY');
  const args = buildArgs({ input: 'rtmp://in', output: 'rtmp://out/K' });
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy']);
  assert.equal(args.at(-1), 'rtmp://out/K');
  assert.equal(maskSecrets('error rtmp://out/SECRET123 failed', ['SECRET123']), 'error rtmp://out/*** failed');
});
