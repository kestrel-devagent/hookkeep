/** Unit: auto-forward retries with backoff — shared src/forward-retry.js, Node db (temp dir), Workers fetch (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeForwardRetryPatch,
  forwardRetryConfig,
  publicForwardRetryConfig,
  backoffSchedule,
  isRetryableResult,
  startForwardRecord,
  applyForwardAttempt,
  deliverWithRetries,
  forwardStateOf,
  forwardFilterMatch,
  publicForwardFields,
  FORWARD_ATTEMPTS_KEEP,
} from '../src/forward-retry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers
assert.deepEqual(normalizeForwardRetryPatch({}).patch, {});
assert.deepEqual(normalizeForwardRetryPatch({ forwardRetries: '3', forwardBackoffMs: 250 }).patch, {
  forwardRetries: 3,
  forwardBackoffMs: 250,
});
assert.equal(normalizeForwardRetryPatch({ forwardRetries: 6 }).error, 'bad_forward_retries');
assert.equal(normalizeForwardRetryPatch({ forwardRetries: 1.5 }).error, 'bad_forward_retries');
assert.equal(normalizeForwardRetryPatch({ forwardRetries: -1 }).error, 'bad_forward_retries');
assert.equal(normalizeForwardRetryPatch({ forwardBackoffMs: 50 }).error, 'bad_forward_backoff');
assert.equal(normalizeForwardRetryPatch({ forwardBackoffMs: 60_001 }).error, 'bad_forward_backoff');
assert.equal(normalizeForwardRetryPatch({ forwardBackoffMs: 0 }).patch.forwardBackoffMs, 1000, '0 = default');
assert.deepEqual(forwardRetryConfig({}), { retries: 0, backoffMs: 1000 });
assert.deepEqual(forwardRetryConfig({ forwardRetries: 99, forwardBackoffMs: 5 }), { retries: 5, backoffMs: 1000 });
assert.deepEqual(backoffSchedule(5, 1000), [1000, 2000, 4000, 8000, 16000]);
assert.deepEqual(backoffSchedule(5, 60_000), [60_000, 120_000, 240_000, 300_000, 300_000], 'gap cap 5 min');
assert.deepEqual(publicForwardRetryConfig({ forwardRetries: 2, forwardBackoffMs: 500 }), {
  forwardRetries: 2,
  forwardBackoffMs: 500,
  forwardSchedule: [500, 1000],
});
for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableResult({ ok: false, status: s }), true, `${s}`);
for (const s of [400, 401, 403, 404, 410, 422]) assert.equal(isRetryableResult({ ok: false, status: s }), false, `${s}`);
assert.equal(isRetryableResult({ ok: false, error: 'forward_failed' }), true, 'network error');
assert.equal(isRetryableResult({ ok: false, error: 'bad_url' }), false);
assert.equal(isRetryableResult({ ok: true, status: 200 }), false);

{
  // 503 → 503 → 200 with 2 retries
  let rec = startForwardRecord({ target: 'https://x.test/h', retries: 2, backoffMs: 1000 });
  assert.equal(rec.state, 'pending');
  assert.equal(rec.maxAttempts, 3);
  let step = applyForwardAttempt(rec, { ok: false, status: 503, ms: 5, target: 'https://x.test/h' }, { now: 0 });
  assert.equal(step.nextDelayMs, 1000);
  assert.equal(step.record.state, 'pending');
  assert.equal(step.record.nextAttemptAt, new Date(1000).toISOString());
  step = applyForwardAttempt(step.record, { ok: false, status: 503 }, { now: 1000 });
  assert.equal(step.nextDelayMs, 2000);
  step = applyForwardAttempt(step.record, { ok: true, status: 200, ms: 3 }, { now: 3000 });
  assert.equal(step.nextDelayMs, null);
  assert.equal(step.record.state, 'delivered');
  assert.equal(step.record.ok, true);
  assert.equal(step.record.status, 200);
  assert.equal(step.record.attemptCount, 3);
  assert.equal(step.record.attempts.length, 3);
  assert.ok(!step.record.nextAttemptAt && !step.record.error && !step.record.gaveUp);

  // exhausted
  rec = startForwardRecord({ target: 't', retries: 1, backoffMs: 100 });
  step = applyForwardAttempt(rec, { ok: false, status: 500 });
  step = applyForwardAttempt(step.record, { ok: false, error: 'forward_failed', message: 'ECONNREFUSED' });
  assert.equal(step.record.state, 'failed');
  assert.equal(step.record.gaveUp, 'exhausted');
  assert.equal(step.record.error, 'forward_failed');
  assert.equal(step.record.message, 'ECONNREFUSED');
  assert.equal(step.record.status, undefined, 'last attempt had no status');

  // non-retryable 4xx stops at once
  rec = startForwardRecord({ target: 't', retries: 5 });
  step = applyForwardAttempt(rec, { ok: false, status: 404 });
  assert.equal(step.nextDelayMs, null);
  assert.equal(step.record.state, 'failed');
  assert.equal(step.record.gaveUp, 'non_retryable');

  // manual retry flips failed → delivered, never schedules
  step = applyForwardAttempt(step.record, { ok: true, status: 200 }, { manual: true });
  assert.equal(step.record.state, 'delivered');
  assert.equal(step.record.attempts.at(-1).manual, true);
  step = applyForwardAttempt(step.record, { ok: false, status: 503 }, { manual: true });
  assert.equal(step.nextDelayMs, null, 'manual never schedules');
  assert.equal(step.record.state, 'failed');

  // legacy single-attempt record (pre-retry) upgrades cleanly
  const legacy = { ok: false, status: 502, ms: 9, target: 't' };
  assert.equal(forwardStateOf({ autoForward: legacy }), 'failed');
  assert.equal(forwardStateOf({ autoForward: { ok: true } }), 'delivered');
  assert.equal(forwardStateOf({}), null);
  step = applyForwardAttempt(legacy, { ok: true, status: 200 }, { manual: true });
  assert.equal(step.record.attemptCount, 2);
  assert.equal(step.record.state, 'delivered');

  // history cap
  rec = startForwardRecord({ target: 't', retries: 0 });
  for (let i = 0; i < FORWARD_ATTEMPTS_KEEP + 5; i++) rec = applyForwardAttempt(rec, { ok: false, status: 500 }, { manual: true }).record;
  assert.equal(rec.attempts.length, FORWARD_ATTEMPTS_KEEP);
  assert.equal(rec.attemptCount, FORWARD_ATTEMPTS_KEEP + 5);

  // filters + list fields
  const evs = [
    { id: 'a', autoForward: { state: 'delivered', ok: true, attemptCount: 2 } },
    { id: 'b', autoForward: { state: 'failed', ok: false } },
    { id: 'c', autoForward: { state: 'pending', ok: false } },
    { id: 'd' },
  ];
  const ids = (f) => evs.filter((e) => forwardFilterMatch(e, f)).map((e) => e.id).join('');
  assert.equal(ids('failed'), 'b');
  assert.equal(ids('pending'), 'c');
  assert.equal(ids('delivered'), 'a');
  assert.equal(ids('none'), 'd');
  assert.equal(ids(''), 'abcd');
  assert.equal(ids('bogus'), 'abcd');
  assert.deepEqual(publicForwardFields(evs[0]), { forwardState: 'delivered', forwardAttempts: 2 });
  assert.deepEqual(publicForwardFields(evs[3]), { forwardState: null, forwardAttempts: 0 });
}

{
  // deliverWithRetries with a fake clock: budget cut-off → gaveUp budget
  let t = 0;
  const clock = () => t;
  const fakeSleep = async (ms) => {
    t += ms;
  };
  const calls = [];
  const out = await deliverWithRetries({
    record: startForwardRecord({ target: 't', retries: 5, backoffMs: 4000 }),
    budgetMs: 25_000,
    clock,
    sleep: fakeSleep,
    attempt: async (timeout, n) => {
      calls.push({ timeout, n });
      t += 100;
      return { ok: false, status: 503 };
    },
  });
  // gaps 4s, 8s fit (t≈12.3s); the 16s gap would end past 25s → stop
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.n), [1, 2, 3]);
  assert.equal(out.state, 'failed');
  assert.equal(out.gaveUp, 'budget');
  assert.ok(!out.nextAttemptAt);

  t = 0;
  const ok = await deliverWithRetries({
    record: startForwardRecord({ target: 't', retries: 3, backoffMs: 100 }),
    clock,
    sleep: fakeSleep,
    attempt: async (_timeout, n) => (n < 3 ? { ok: false, error: 'forward_failed' } : { ok: true, status: 204 }),
  });
  assert.equal(ok.state, 'delivered');
  assert.equal(ok.attemptCount, 3);
  assert.equal(t, 300, 'slept 100 + 200');
}

// --- local receiver: /flaky-N fails N times with 503 then 200; /bad → 400; /down → always 503
const hits = new Map();
const seenAttempts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = req.url.split('?')[0];
    const n = (hits.get(p) || 0) + 1;
    hits.set(p, n);
    seenAttempts.push({ p, attempt: req.headers['x-hookkeep-attempt'] });
    const m = /^\/flaky-(\d+)/.exec(p);
    let status = 200;
    if (m && n <= Number(m[1])) status = 503;
    if (p.startsWith('/bad')) status = 400;
    if (p.startsWith('/down')) status = 503;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(25);
  }
};

// --- Node db path (isolated temp data dir)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-fwdretry-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const created = db.createWorkspace({ email: 'retry-unit@example.com', label: 'retry' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: created.workspace.id });
  const inboxId = created.inbox.id;
  assert.equal(created.inbox.forwardRetries, 0);
  assert.equal(created.inbox.forwardBackoffMs, 1000);
  assert.deepEqual(created.inbox.forwardSchedule, []);

  const bad = (() => {
    try {
      db.updateInbox(ws, inboxId, { forwardRetries: 9, name: 'should-not-apply' });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(bad?.code, 'bad_forward_retries');
  assert.notEqual(db.getInbox(inboxId).name, 'should-not-apply', 'nothing applied on bad patch');

  const set = db.updateInbox(ws, inboxId, {
    forwardUrl: `${base}/flaky-2`,
    autoForward: true,
    forwardRetries: 3,
    forwardBackoffMs: 100,
  });
  assert.deepEqual(set.forwardSchedule, [100, 200, 400]);

  const ingest = (bodyText) => {
    const r = db.ingestEvent(inboxId, { method: 'POST', headers: {}, bodyText, contentType: 'application/json' });
    return r;
  };

  // flaky-2: attempt 1 in-request 503 → pending; background retries 2 (503) and 3 (200) → delivered
  const r1 = ingest('{"n":1}');
  assert.deepEqual(r1.autoForwardRetry, { retries: 3, backoffMs: 100 });
  const af1 = await db.runAutoForward(r1.eventId, r1.autoForwardTarget, r1.autoForwardRetry);
  assert.equal(af1.state, 'pending');
  assert.equal(af1.status, 503);
  assert.ok(af1.nextAttemptAt);
  assert.equal(db.pendingForwardTimers(), 1);
  assert.equal(db.listEvents(ws, inboxId, { forward: 'pending' }).length, 1);
  const done1 = await waitFor(() => db.getEvent(ws, r1.eventId).autoForward.state === 'delivered');
  assert.ok(done1, `flaky-2 should deliver: ${JSON.stringify(db.getEvent(ws, r1.eventId).autoForward)}`);
  const ev1 = db.getEvent(ws, r1.eventId).autoForward;
  assert.equal(ev1.attemptCount, 3);
  assert.deepEqual(ev1.attempts.map((a) => a.status), [503, 503, 200]);
  assert.equal(hits.get('/flaky-2'), 3);
  assert.deepEqual(
    seenAttempts.filter((s) => s.p === '/flaky-2').map((s) => s.attempt),
    ['1', '2', '3'],
    'x-hookkeep-attempt header'
  );
  assert.equal(db.pendingForwardTimers(), 0);

  // /down: exhausts 1 + 3 retries → failed (exhausted)
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/down` });
  const r2 = ingest('{"n":2}');
  await db.runAutoForward(r2.eventId, r2.autoForwardTarget, r2.autoForwardRetry);
  const done2 = await waitFor(() => db.getEvent(ws, r2.eventId).autoForward.state === 'failed');
  assert.ok(done2);
  const ev2 = db.getEvent(ws, r2.eventId).autoForward;
  assert.equal(ev2.attemptCount, 4);
  assert.equal(ev2.gaveUp, 'exhausted');

  // /bad: 400 → failed immediately, no retry scheduled
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/bad` });
  const r3 = ingest('{"n":3}');
  const af3 = await db.runAutoForward(r3.eventId, r3.autoForwardTarget, r3.autoForwardRetry);
  assert.equal(af3.state, 'failed');
  assert.equal(af3.gaveUp, 'non_retryable');
  assert.equal(db.pendingForwardTimers(), 0);
  assert.equal(hits.get('/bad'), 1);

  // retries 0 keeps the old single-attempt behaviour
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/down`, forwardRetries: 0 });
  const r4 = ingest('{"n":4}');
  const af4 = await db.runAutoForward(r4.eventId, r4.autoForwardTarget, r4.autoForwardRetry);
  assert.equal(af4.state, 'failed');
  assert.equal(af4.attemptCount, 1);

  // filters / summary / export / csv
  const failedRows = db.listEvents(ws, inboxId, { forward: 'failed' });
  assert.deepEqual(new Set(failedRows.map((e) => e.id)), new Set([r2.eventId, r3.eventId, r4.eventId]));
  assert.equal(db.listEvents(ws, inboxId, { forward: 'delivered' })[0].id, r1.eventId);
  assert.equal(db.listEvents(ws, inboxId, { forward: 'delivered' })[0].forwardAttempts, 3);
  const exp = db.exportEvents(ws, inboxId, { forward: 'failed' });
  assert.equal(exp.events.length, 3);
  assert.ok(exp.events.every((e) => e.autoForward.state === 'failed' && Array.isArray(e.autoForward.attempts)));
  const csv = db.eventsToCsv(db.exportEvents(ws, inboxId, {}).raw);
  assert.ok(csv.split('\n')[0].endsWith(',dedupeKey,forwardState,forwardAttempts,redactedHeaders,redactedJsonPaths'));
  assert.ok(csv.includes(',delivered,3'));

  // manual retry-failed: override target that now works → all three delivered
  const rr = await db.retryFailedForwards(ws, inboxId, { targetUrl: `${base}/ok` });
  assert.equal(rr.attempted, 3);
  assert.equal(rr.succeeded, 3);
  assert.equal(rr.ok, true);
  assert.equal(db.listEvents(ws, inboxId, { forward: 'failed' }).length, 0);
  const ev3 = db.getEvent(ws, r3.eventId).autoForward;
  assert.equal(ev3.state, 'delivered');
  assert.equal(ev3.attempts.at(-1).manual, true);
  // nothing left → no-op
  const rr2 = await db.retryFailedForwards(ws, inboxId, {});
  assert.equal(rr2.attempted, 0);

  // manual retry that still fails stays failed; 207-style ok:false
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/bad`, forwardRetries: 0 });
  const r5 = ingest('{"n":5}');
  await db.runAutoForward(r5.eventId, r5.autoForwardTarget, r5.autoForwardRetry);
  const rr3 = await db.retryFailedForwards(ws, inboxId, {});
  assert.equal(rr3.ok, false);
  assert.equal(rr3.results[0].status, 400);
  assert.equal(db.getEvent(ws, r5.eventId).autoForward.state, 'failed');
  // no override → the inbox's CURRENT forwardUrl wins over the event's original (fixed URL)
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/fixed` });
  const rr4 = await db.retryFailedForwards(ws, inboxId, {});
  assert.equal(rr4.succeeded, 1);
  assert.equal(rr4.results[0].target, `${base}/fixed`);
  assert.equal(db.getEvent(ws, r5.eventId).autoForward.state, 'delivered');

  // resumePendingForwards: a pending record left by a "crash" gets re-armed and finishes
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/ok`, forwardRetries: 2, forwardBackoffMs: 100 });
  const r6 = ingest('{"n":6}');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'hookkeep.json'), 'utf8'));
  raw.events[r6.eventId].autoForward = {
    ...startForwardRecord({ target: `${base}/ok`, retries: 2, backoffMs: 100 }),
    attemptCount: 1,
    autoAttempts: 1,
    ok: false,
    status: 503,
    attempts: [{ n: 1, at: new Date().toISOString(), ok: false, status: 503, retryable: true }],
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
  };
  fs.writeFileSync(path.join(tmp, 'hookkeep.json'), JSON.stringify(raw));
  assert.equal(db.resumePendingForwards(), 1);
  const done6 = await waitFor(() => db.getEvent(ws, r6.eventId).autoForward.state === 'delivered');
  assert.ok(done6, 'resumed retry should deliver');

  // deleted mid-backoff → timer cancelled, nothing re-created
  db.updateInbox(ws, inboxId, { forwardUrl: `${base}/down`, forwardRetries: 2, forwardBackoffMs: 300 });
  const r7 = ingest('{"n":7}');
  await db.runAutoForward(r7.eventId, r7.autoForwardTarget, r7.autoForwardRetry);
  assert.equal(db.pendingForwardTimers(), 1);
  const del = db.deleteEventsBulk(ws, inboxId, { q: '"n":7', confirm: true });
  assert.equal(del.deleted, 1);
  assert.equal(db.pendingForwardTimers(), 0);
}

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
    async put(k, v) {
      m.set(k, typeof v === 'string' ? v : String(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) };
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
const created = await (
  await call('/api/workspace', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
).json();
const tok = created.ownerToken;
const inboxId = created.inbox.id;
assert.equal(created.inbox.forwardRetries, 0);
const auth = { 'x-hookkeep-token': tok };
const patch = (b) =>
  call(`/api/inboxes/${inboxId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(b),
  });
const badW = await patch({ forwardBackoffMs: 10 });
assert.equal(badW.status, 400);
assert.equal((await badW.json()).error, 'bad_forward_backoff');
const okW = await (await patch({ forwardUrl: `${base}/flaky-1`, autoForward: true, forwardRetries: 2, forwardBackoffMs: 100 })).json();
assert.deepEqual(okW.inbox.forwardSchedule, [100, 200]);

const hookW = (b) => call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
const w1 = await (await hookW('{"w":1}')).json();
assert.equal(w1.autoForward.state, 'pending');
assert.equal(w1.autoForward.maxAttempts, 3);
const d1 = await (await call(`/api/events/${w1.id}`, { headers: auth })).json();
assert.equal(d1.event.autoForward.state, 'delivered');
assert.deepEqual(d1.event.autoForward.attempts.map((a) => a.status), [503, 200]);

await patch({ forwardUrl: `${base}/bad` });
const w2 = await (await hookW('{"w":2}')).json();
const d2 = await (await call(`/api/events/${w2.id}`, { headers: auth })).json();
assert.equal(d2.event.autoForward.state, 'failed');
assert.equal(d2.event.autoForward.gaveUp, 'non_retryable');

const listW = await (await call(`/api/inboxes/${inboxId}/events?forward=failed`, { headers: auth })).json();
assert.deepEqual(listW.events.map((e) => e.id), [w2.id]);
assert.equal(listW.events[0].forwardState, 'failed');
const csvW = await (await call(`/api/inboxes/${inboxId}/events/export?format=csv&forward=delivered`, { headers: auth })).text();
assert.ok(csvW.split('\n')[0].endsWith(',forwardState,forwardAttempts,redactedHeaders,redactedJsonPaths'));
assert.equal(csvW.trim().split('\n').length, 2, 'one delivered row');

const rw = await call(`/api/inboxes/${inboxId}/events/retry-forwards`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ targetUrl: `${base}/ok-w` }),
});
assert.equal(rw.status, 200);
const rwj = await rw.json();
assert.equal(rwj.attempted, 1);
assert.equal(rwj.results[0].state, 'delivered');
const d2b = await (await call(`/api/events/${w2.id}`, { headers: auth })).json();
assert.equal(d2b.event.autoForward.state, 'delivered');
assert.equal(d2b.event.autoForward.attempts.at(-1).manual, true);
const unauth = await call(`/api/inboxes/${inboxId}/events/retry-forwards`, { method: 'POST', body: '{}' });
assert.equal(unauth.status, 401);

server.close();
console.log('FORWARD RETRY UNIT OK');
