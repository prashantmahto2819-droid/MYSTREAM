import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/analytics.js';
import { openDb } from '../src/db.js';

test('analytics: counts lives and minutes per day, ignores other actions', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');
  const r = summarize([
    { ts: '2026-11-19 08:00:00', action: 'studio_started', detail: '720p' },
    { ts: '2026-11-19 09:00:00', action: 'studio_stopped', detail: '120 MB, 1800s' },
    { ts: '2026-11-18 09:00:00', action: 'obs_live_started', detail: '2 destinations' },
    { ts: '2026-11-18 10:00:00', action: 'login', detail: '' },
    { ts: '2026-01-01 10:00:00', action: 'studio_started', detail: '' },
  ], { days: 3, now });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-11-17', '2026-11-18', '2026-11-19']);
  assert.deepEqual(r.days.map((d) => d.lives), [0, 1, 1]);
  assert.equal(r.days[2].minutes, 30);
  assert.deepEqual(r.totals, { lives: 2, minutes: 30 });
});

test('analytics: store query returns only live-related rows for that user', () => {
  const store = openDb(':memory:');
  const a = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const b = store.createUser({ email: 'b@x.com', name: 'B', passwordHash: 'h' });
  store.addActivity(a, 'studio_started'); store.addActivity(a, 'login'); store.addActivity(b, 'studio_started');
  assert.equal(store.activitySince(a, 14).length, 1);
  assert.equal(store.activitySince(null, 14).length, 2);
});
