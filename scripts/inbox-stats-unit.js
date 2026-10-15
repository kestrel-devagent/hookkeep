/** Unit: inbox stats — shared src/inbox-stats.js helpers, Node db path (temp data dir), Workers fetch path (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseStatsWindow,
  windowStartedAt,
  eventInWindow,
  statusBucket,
  signatureBucket,
  forwardBucket,
  computeInboxStats,
  STATS_WINDOWS,
  DEFAULT_STATS_WINDOW,
} from '../src/inbox-stats.js';

// --- helpers
assert.equal(DEFAULT_STATS_WINDOW, '24h');
assert.deepEqual(STATS_WINDOWS, ['1h', '24h', '7d', 'all']);
assert.deepEqual(parseStatsWindow(undefined), { ok: true, window: '24h' });
assert.deepEqual(parseStatsWindow(''), { ok: true, window: '24h' });
assert.deepEqual(parseStatsWindow('7D'), { ok: true, window: '7d' });
assert.equal(parseStatsWindow('30d').error, 'bad_window');
assert.equal(parseStatsWindow('yesterday').error, 'bad_window');

{
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  assert.equal(windowStartedAt('all', now), null);
  assert.equal(windowStartedAt('1h', now), '2026-10-15T11:00:00.000Z');
  assert.equal(windowStartedAt('24h', now), '2026-10-14T12:00:00.000Z');
  assert.equal(windowStartedAt('7d', now), '2026-10-08T12:00:00.000Z');
  assert.equal(eventInWindow({ receivedAt: '2026-10-15T11:30:00.000Z' }, '1h', now), true);
  assert.equal(eventInWindow({ receivedAt: '2026-10-15T10:59:00.000Z' }, '1h', now), false);
  assert.equal(eventInWindow({ receivedAt: '2020-01-01T00:00:00.000Z' }, 'all', now), true);
  assert.equal(eventInWindow({ receivedAt: 'not-a-date' }, '24h', now), false);
}

assert.equal(statusBucket(200), '2xx');
assert.equal(statusBucket('201'), '2xx');
assert.equal(statusBucket(302), '3xx');
assert.equal(statusBucket(404), '4xx');
assert.equal(statusBucket(503), '5xx');
assert.equal(statusBucket('error'), 'other');
assert.equal(statusBucket(null), 'other');
assert.equal(statusBucket(99), 'other');

assert.equal(signatureBucket({ signature: { valid: true } }), 'valid');
assert.equal(signatureBucket({ signature: { valid: false, reason: 'bad' } }), 'invalid');
assert.equal(signatureBucket({}), 'unchecked');
assert.equal(signatureBucket({ signature: { scheme: 'stripe' } }), 'unchecked');

assert.equal(forwardBucket({ autoForward: { ok: true, state: 'delivered' } }), 'delivered');
assert.equal(forwardBucket({ autoForward: { ok: false, state: 'pending' } }), 'pending');
assert.equal(forwardBucket({ autoForward: { ok: false, state: 'failed' } }), 'failed');
assert.equal(forwardBucket({ autoForward: { ok: true } }), 'delivered'); // legacy
assert.equal(forwardBucket({ autoForward: { ok: false } }), 'failed'); // legacy
assert.equal(forwardBucket({}), 'none');

{
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const events = [
    {
      id: 'a',
      method: 'POST',
      statusGuess: '200',
      receivedAt: '2026-10-15T11:30:00.000Z',
      pinned: true,
      signature: { valid: true },
      autoForward: { ok: true, state: 'delivered' },
    },
    {
      id: 'b',
      method: 'get',
      statusGuess: 404,
      receivedAt: '2026-10-15T11:45:00.000Z',
      signature: { valid: false },
      autoForward: { ok: false, state: 'failed' },
    },
    {
      id: 'c',
      method: 'POST',
      statusGuess: 'oops',
      receivedAt: '2026-10-14T10:00:00.000Z', // outside 1h
    },
    {
      id: 'd',
      method: 'POST',
      statusGuess: 503,
      receivedAt: '2026-10-15T11:50:00.000Z',
      autoForward: { ok: false, state: 'pending' },
    },
  ];
  const s1 = computeInboxStats(events, { inboxId: 'ibox', window: '1h', now });
  assert.equal(s1.ok, true);
  assert.equal(s1.inboxId, 'ibox');
  assert.equal(s1.window, '1h');
  assert.equal(s1.windowStartedAt, '2026-10-15T11:00:00.000Z');
  assert.equal(s1.total, 3);
  assert.equal(s1.pinned, 1);
  assert.deepEqual(s1.byMethod, { POST: 2, GET: 1 });
  assert.deepEqual(s1.byStatusBucket, { '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 1, other: 0 });
  assert.deepEqual(s1.byForwardState, { delivered: 1, pending: 1, failed: 1, none: 0 });
  assert.deepEqual(s1.bySignature, { valid: 1, invalid: 1, unchecked: 1 });
  assert.equal(s1.oldestReceivedAt, '2026-10-15T11:30:00.000Z');
  assert.equal(s1.newestReceivedAt, '2026-10-15T11:50:00.000Z');

  const sall = computeInboxStats(events, { inboxId: 'ibox', window: 'all', now });
  assert.equal(sall.total, 4);
  assert.equal(sall.windowStartedAt, null);
  assert.equal(sall.byStatusBucket.other, 1);
  assert.equal(sall.byForwardState.none, 1);

  const empty = computeInboxStats([], { inboxId: 'x', window: '24h', now });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.byMethod, {});
  assert.equal(empty.oldestReceivedAt, null);
  assert.equal(empty.newestReceivedAt, null);

  assert.equal(computeInboxStats([], { window: 'nope' }).error, 'bad_window');
}

// --- Node db path
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-stats-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const { workspace, inbox } = db.createWorkspace({ email: 'stats-unit@example.com' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: workspace.id });
  const inboxId = inbox.id;

  assert.equal(db.inboxStats(ws, 'missing'), null);
  const bad = db.inboxStats(ws, inboxId, { window: '30d' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_window');

  const empty = db.inboxStats(ws, inboxId, { window: '24h' });
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
  assert.equal(empty.inboxId, inboxId);

  db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: JSON.stringify({ status: 200, n: 1 }),
    contentType: 'application/json',
    signature: { scheme: 'stripe', valid: true, reason: 'ok' },
  });
  db.ingestEvent(inboxId, {
    method: 'GET',
    headers: {},
    bodyText: JSON.stringify({ status: 500, n: 2 }),
    contentType: 'application/json',
    signature: { scheme: 'stripe', valid: false, reason: 'bad_sig' },
  });
  const evs = Object.values(JSON.parse(fs.readFileSync(path.join(tmp, 'hookkeep.json'), 'utf8')).events).filter(
    (e) => e.inboxId === inboxId
  );
  // pin one
  const pinId = evs[0].id;
  db.updateEventPin(ws, pinId, { pinned: true, note: 'keep' });

  const s = db.inboxStats(ws, inboxId, { window: 'all' });
  assert.equal(s.total, 2);
  assert.equal(s.pinned, 1);
  assert.equal(s.byMethod.POST, 1);
  assert.equal(s.byMethod.GET, 1);
  assert.equal(s.byStatusBucket['2xx'], 1);
  assert.equal(s.byStatusBucket['5xx'], 1);
  assert.equal(s.bySignature.valid, 1);
  assert.equal(s.bySignature.invalid, 1);
  assert.equal(s.byForwardState.none, 2);
  assert.ok(s.oldestReceivedAt);
  assert.ok(s.newestReceivedAt);
  assert.ok(s.generatedAt);
}

// --- Workers fetch path with a KV mock
import worker from '../workers/src/worker.js';

function makeKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, typeof v === 'string' ? v : String(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix, limit }) {
      const keys = [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit == null ? undefined : limit)
        .map((name) => ({ name }));
      return { keys };
    },
  };
}
const kv = makeKv();
const env = { HOOKKEEP_KV: kv };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, init = {}) => {
  const res = await worker.fetch(new Request(`https://hk.test${path}`, init), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
};
const created = await (
  await call('/api/workspace', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
).json();
const tok = created.ownerToken;
const inboxId = created.inbox.id;
const auth = { 'x-hookkeep-token': tok };

const unauth = await call(`/api/inboxes/${inboxId}/stats`);
assert.equal(unauth.status, 401);

const badW = await call(`/api/inboxes/${inboxId}/stats?window=year`, { headers: auth });
assert.equal(badW.status, 400);
assert.equal((await badW.json()).error, 'bad_window');

const missing = await call('/api/inboxes/nope/stats', { headers: auth });
assert.equal(missing.status, 404);

await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 201, w: 1 }),
});
await call(`/hook/${inboxId}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 404, w: 2 }),
});

const def = await (await call(`/api/inboxes/${inboxId}/stats`, { headers: auth })).json();
assert.equal(def.ok, true);
assert.equal(def.window, '24h');
assert.equal(def.inboxId, inboxId);
assert.equal(def.total, 2);
assert.equal(def.byMethod.POST, 1);
assert.equal(def.byMethod.PUT, 1);
assert.equal(def.byStatusBucket['2xx'], 1);
assert.equal(def.byStatusBucket['4xx'], 1);
assert.ok(def.windowStartedAt);
assert.ok(def.generatedAt);

const all = await (await call(`/api/inboxes/${inboxId}/stats?window=all`, { headers: auth })).json();
assert.equal(all.window, 'all');
assert.equal(all.windowStartedAt, null);
assert.equal(all.total, 2);

console.log('INBOX STATS UNIT OK');
