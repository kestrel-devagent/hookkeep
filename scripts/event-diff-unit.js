/** Unit: event diff — shared src/event-diff.js helpers, Node db path (temp data dir), Workers fetch path (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseIgnore,
  isIgnored,
  diffJson,
  diffText,
  diffHeaders,
  diffEvents,
  previousEvent,
  diffOptionsFromQuery,
  DIFF_MAX_CHANGES,
} from '../src/event-diff.js';

// --- helpers
assert.deepEqual(parseIgnore(''), { ok: true, patterns: [] });
assert.deepEqual(parseIgnore(' id, created ,,data.object.id ').patterns, ['id', 'created', 'data.object.id']);
assert.equal(parseIgnore(Array.from({ length: 21 }, (_, i) => `p${i}`).join(',')).error, 'bad_ignore');
assert.equal(parseIgnore('a b').error, 'bad_ignore');
assert.equal(isIgnored('data.object.id', ['data.object']), true, 'prefix ignores children');
assert.equal(isIgnored('data.objectx', ['data.object']), false, 'segment-exact');
assert.equal(isIgnored('items[3].id', ['items[*].id']), true);
assert.equal(isIgnored('items[3].name', ['items[*].id']), false);
assert.equal(isIgnored('data.a.updated', ['data.*.updated']), true);
{
  const r = diffJson(
    { id: 'evt_1', type: 'invoice.paid', data: { amount: 900, currency: 'usd', lines: [1, 2] }, gone: true },
    { id: 'evt_2', type: 'invoice.paid', data: { amount: '900', currency: 'usd', lines: [1, 2, 3], coupon: 'X' } },
    { ignore: ['id'] }
  );
  const by = Object.fromEntries(r.changes.map((c) => [c.path, c]));
  assert.equal(r.ignored, 1, 'id change ignored');
  assert.equal(by['data.amount'].kind, 'type');
  assert.equal(by['data.amount'].beforeType, 'number');
  assert.equal(by['data.amount'].afterType, 'string');
  assert.equal(by['data.lines[2]'].kind, 'added');
  assert.equal(by['data.coupon'].after, 'X');
  assert.equal(by.gone.kind, 'removed');
  assert.equal(r.changes.length, 4);
  assert.equal(by.id, undefined);
}
{
  const r = diffJson({ 'odd key': 1 }, { 'odd key': 2 });
  assert.equal(r.changes[0].path, '["odd key"]');
  const big = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
  const r2 = diffJson({}, big);
  assert.equal(r2.changes.length, DIFF_MAX_CHANGES);
  assert.equal(r2.truncated, true);
  const r3 = diffJson({ s: 'x' }, { s: 'y'.repeat(500) });
  assert.ok(r3.changes[0].after.length <= 201 && r3.changes[0].after.endsWith('…'), 'long values truncated');
  assert.deepEqual(diffJson([1, { a: 1 }], [1, { a: 1 }]).changes, []);
}
{
  const r = diffText('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(
    r.changes.map((c) => `${c.kind}:${c.text}`).sort(),
    ['added:B', 'added:d', 'removed:b'].sort()
  );
  assert.equal(r.approximate, false);
  const long = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
  const r2 = diffText(long, long.replace('l7\n', 'L7\n'));
  assert.equal(r2.approximate, true);
  assert.equal(r2.changes.length, 2);
}
{
  const h = diffHeaders(
    { 'Content-Type': 'application/json', Date: 'Mon', 'Stripe-Signature': 't=1', 'X-Api-Version': '2024-06-20' },
    { 'content-type': 'application/json', date: 'Tue', 'stripe-signature': 't=2', 'x-api-version': '2026-09-30', 'x-new': '1' }
  );
  assert.deepEqual(h.changes.map((c) => `${c.kind}:${c.name}`), ['changed:x-api-version', 'added:x-new']);
  assert.equal(h.volatileSkipped, 2);
  const all = diffHeaders({ date: 'Mon' }, { date: 'Tue' }, { allHeaders: true });
  assert.equal(all.changes.length, 1);
}
{
  const a = { id: 'ev_a', method: 'POST', bodyText: '{"x":1}', headers: {}, contentType: 'application/json', size: 7 };
  const b = { id: 'ev_b', method: 'POST', bodyText: '{"x":1}', headers: {}, contentType: 'application/json', size: 7 };
  const same = diffEvents(a, b);
  assert.equal(same.identical, true, 'parses bodyText JSON when bodyJson missing');
  assert.equal(same.body.mode, 'json');
  const t = diffEvents({ ...a, bodyText: 'k=1&z=2', contentType: 'x' }, { ...b, bodyText: 'k=2&z=2', contentType: 'x', signature: { valid: false } });
  assert.equal(t.body.mode, 'text');
  assert.equal(t.identical, false);
  assert.deepEqual(t.meta.map((m) => m.field), ['signatureValid']);
  assert.equal(t.summary.bodyAdded, 1);
  assert.equal(t.summary.bodyRemoved, 1);
}
{
  const evs = [
    { id: 'e1', receivedAt: '2026-10-09T10:00:00.000Z' },
    { id: 'e2', receivedAt: '2026-10-09T10:00:01.000Z' },
    { id: 'e3', receivedAt: '2026-10-09T10:00:01.000Z' },
  ];
  assert.equal(previousEvent(evs, evs[0]), null);
  assert.equal(previousEvent(evs, evs[2]).id, 'e2', 'same-ms keeps insertion order');
  assert.equal(previousEvent(evs, evs[1]).id, 'e1');
  const q = new URLSearchParams('against=ev_x&ignore=id,created&headers=all');
  assert.deepEqual(diffOptionsFromQuery((k) => q.get(k)), { ok: true, against: 'ev_x', ignore: ['id', 'created'], allHeaders: true });
}

// --- Node db path
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-diff-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const { workspace, inbox } = db.createWorkspace({ email: 'diff-unit@example.com' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: workspace.id });
  const ing = (obj, headers = {}) =>
    db.ingestEvent(inbox.id, { method: 'POST', headers, bodyText: JSON.stringify(obj), contentType: 'application/json' }).eventId;
  const e1 = ing({ id: 'evt_1', type: 'order.created', total: 10 }, { 'x-shop-version': '1' });
  await new Promise((r) => setTimeout(r, 2));
  const e2 = ing({ id: 'evt_2', type: 'order.created', total: 12, discount: 2 }, { 'x-shop-version': '2' });
  assert.equal(db.diffEvent(ws, 'ev_missing'), null);
  assert.equal(db.diffEvent(ws, e1).error, 'no_baseline');
  const d = db.diffEvent(ws, e2, { ignore: ['id'] });
  assert.equal(d.ok, true);
  assert.equal(d.baselineMode, 'previous');
  assert.equal(d.base.id, e1);
  assert.equal(d.target.id, e2);
  assert.deepEqual(d.body.changes.map((c) => c.path), ['total', 'discount']);
  assert.equal(d.body.ignoredChanges, 1);
  assert.equal(d.headers.changes[0].name, 'x-shop-version');
  const rev = db.diffEvent(ws, e1, { against: e2 });
  assert.equal(rev.baselineMode, 'against');
  assert.ok(rev.body.changes.some((c) => c.path === 'discount' && c.kind === 'removed'));
  assert.equal(db.diffEvent(ws, e1, { against: e1 }).error, 'same_event');
  assert.equal(db.diffEvent(ws, e1, { against: 'ev_nope' }).error, 'against_not_found');
  // other workspace can't see either event
  const other = db.createWorkspace({ email: 'diff-other@example.com' });
  const ows = db.getWorkspaceByIdOrEmail({ workspaceId: other.workspace.id });
  assert.equal(db.diffEvent(ows, e2), null);
  const oe = db.ingestEvent(other.inbox.id, { method: 'POST', headers: {}, bodyText: '{}', contentType: 'application/json' }).eventId;
  assert.equal(db.diffEvent(ows, oe, { against: e1 }).error, 'against_not_found', 'cross-workspace baseline hidden');
}
fs.rmSync(tmp, { recursive: true, force: true });

// --- Workers fetch path with a KV mock
const { default: worker } = await import('../workers/src/worker.js');
function makeKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys: limit ? keys.slice(0, limit) : keys };
    },
  };
}
const kv = makeKv();
const env = { HOOKKEEP_KV: kv };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (p, init = {}) => {
  const res = await worker.fetch(new Request(`https://hk.test${p}`, init), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
};
const created = await (await call('/api/workspace', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
const auth = { 'x-hookkeep-token': created.ownerToken };
const inboxId = created.inbox.id;
const hook = async (obj, headers = {}) => {
  const r = await (await call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) })).json();
  await new Promise((res) => setTimeout(res, 2));
  return r.eventId || r.id;
};
const w1 = await hook({ id: 'evt_1', status: 'ok', n: 1 }, { 'x-api-version': 'v1' });
const w2 = await hook({ id: 'evt_2', status: 'ok', n: 2 });
const w3 = await hook({ id: 'evt_3', status: 'failed', n: 3, error: { code: 'card_declined' } }, { 'x-api-version': 'v2' });
assert.ok(w1 && w2 && w3);
assert.equal((await call(`/api/events/${w3}/diff`)).status, 401);
assert.equal((await call(`/api/events/ev_nope/diff`, { headers: auth })).status, 404);
const noBase = await call(`/api/events/${w1}/diff`, { headers: auth });
assert.equal(noBase.status, 404);
assert.equal((await noBase.json()).error, 'no_baseline');
const wd = await (await call(`/api/events/${w3}/diff?ignore=id`, { headers: auth })).json();
assert.equal(wd.ok, true);
assert.equal(wd.base.id, w2, 'previous = the capture right before');
assert.equal(wd.baselineMode, 'previous');
assert.deepEqual(wd.body.changes.map((c) => c.path).sort(), ['error', 'n', 'status'].sort());
assert.deepEqual(wd.headers.changes.map((c) => `${c.kind}:${c.name}`), ['added:x-api-version']);
const wa = await (await call(`/api/events/${w3}/diff?against=${w1}&ignore=id,n`, { headers: auth })).json();
assert.equal(wa.base.id, w1);
assert.equal(wa.baselineMode, 'against');
assert.deepEqual(wa.headers.changes.map((c) => `${c.kind}:${c.name}`), ['changed:x-api-version']);
assert.equal(wa.body.ignoredChanges, 2);
assert.equal((await call(`/api/events/${w3}/diff?against=${w3}`, { headers: auth })).status, 400);
const wMissing = await call(`/api/events/${w3}/diff?against=ev_gone`, { headers: auth });
assert.equal(wMissing.status, 404);
assert.equal((await wMissing.json()).error, 'against_not_found');
assert.equal((await call(`/api/events/${w3}/diff?ignore=a%20b`, { headers: auth })).status, 400);
// POST /diff must not fall into the replay path
assert.equal((await call(`/api/events/${w3}/diff`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
const same = await (await call(`/api/events/${w2}/diff?against=${w1}&ignore=id,n`, { headers: auth })).json();
assert.equal(same.body.changes.length, 0);
assert.equal(same.identical, false, 'header x-api-version removed still counts');
assert.equal(same.headers.changes[0].kind, 'removed');

console.log('EVENT-DIFF UNIT OK');
