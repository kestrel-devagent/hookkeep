/** Unit: per-inbox ingest dedupe — shared src/dedupe.js, Node db (temp dir), Workers fetch (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeDedupePatch,
  normalizeDedupeMode,
  normalizeDedupeHeader,
  publicDedupeConfig,
  headerValue,
  bodyHashHex,
  computeDedupeKey,
  rememberDedupe,
  lookupDedupe,
  forgetDedupeForEvent,
  DEDUPE_MAP_MAX,
  DEDUPE_HEADER_DEFAULT,
} from '../src/dedupe.js';

// --- helpers
assert.equal(normalizeDedupeMode(null), 'none');
assert.equal(normalizeDedupeMode('IDEMPOTENCY'), 'idempotency');
assert.equal(normalizeDedupeMode('body-hash'), 'body-hash');
assert.equal(normalizeDedupeMode('nope'), null);
assert.equal(normalizeDedupeHeader(''), DEDUPE_HEADER_DEFAULT);
assert.equal(normalizeDedupeHeader(' X-Request-Id '), 'x-request-id');
assert.equal(normalizeDedupeHeader('bad header'), null);
assert.equal(normalizeDedupePatch({ dedupeMode: 'md5' }).error, 'bad_dedupe_mode');
assert.deepEqual(normalizeDedupePatch({ dedupeMode: 'either', dedupeHeader: 'Idempotency-Key' }).patch, {
  dedupeMode: 'either',
  dedupeHeader: 'idempotency-key',
});
assert.deepEqual(publicDedupeConfig({}), { dedupeMode: 'none', dedupeHeader: 'idempotency-key' });
assert.equal(headerValue({ 'Idempotency-Key': 'abc' }, 'idempotency-key'), 'abc');
assert.equal(headerValue(new Headers({ 'Idempotency-Key': 'xyz' }), 'idempotency-key'), 'xyz');

const body = '{"id":"evt_1","amount":900}';
const refHex = createHash('sha256').update(body).digest('hex');
assert.equal(await bodyHashHex(body), refHex);
assert.equal(await bodyHashHex(new TextEncoder().encode(body)), refHex);
assert.equal(await bodyHashHex(''), createHash('sha256').update('').digest('hex'));

let ck = await computeDedupeKey({ mode: 'none', headers: { 'idempotency-key': 'k1' }, bodyText: body });
assert.deepEqual(ck, { key: null, source: null });
ck = await computeDedupeKey({ mode: 'idempotency', headers: {}, bodyText: body });
assert.deepEqual(ck, { key: null, source: null }, 'missing header → no key');
ck = await computeDedupeKey({
  mode: 'idempotency',
  headerName: 'x-idem',
  headers: { 'X-Idem': '  retry-1  ' },
  bodyText: body,
});
assert.deepEqual(ck, { key: 'retry-1', source: 'idempotency' });
ck = await computeDedupeKey({ mode: 'body-hash', headers: {}, bodyText: body });
assert.deepEqual(ck, { key: `sha256:${refHex}`, source: 'body-hash' });
ck = await computeDedupeKey({
  mode: 'either',
  headers: { 'idempotency-key': 'prefers-header' },
  bodyText: body,
});
assert.deepEqual(ck, { key: 'prefers-header', source: 'idempotency' });
ck = await computeDedupeKey({ mode: 'either', headers: {}, bodyText: body });
assert.deepEqual(ck, { key: `sha256:${refHex}`, source: 'body-hash' });

{
  const inbox = {};
  rememberDedupe(inbox, 'a', 'ev_1');
  rememberDedupe(inbox, 'b', 'ev_2');
  assert.equal(lookupDedupe(inbox, 'a'), 'ev_1');
  forgetDedupeForEvent(inbox, 'ev_1');
  assert.equal(lookupDedupe(inbox, 'a'), null);
  assert.equal(lookupDedupe(inbox, 'b'), 'ev_2');
  for (let i = 0; i < DEDUPE_MAP_MAX + 10; i++) rememberDedupe(inbox, `k${i}`, `ev_${i}`);
  assert.ok(Object.keys(inbox.dedupeMap).length <= DEDUPE_MAP_MAX);
  assert.ok(inbox.dedupeOrder.length <= DEDUPE_MAP_MAX);
}

// --- Node db path (isolated temp data dir)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-dedupe-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const created = db.createWorkspace({ email: 'dedupe-unit@example.com', label: 'dedupe' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: created.workspace.id });
  const inboxId = created.inbox.id;
  assert.equal(created.inbox.dedupeMode, 'none');
  assert.equal(created.inbox.dedupeHeader, 'idempotency-key');

  // mode none stores duplicates
  const a1 = db.ingestEvent(inboxId, { method: 'POST', headers: {}, bodyText: body, contentType: 'application/json', dedupeKey: null });
  const a2 = db.ingestEvent(inboxId, { method: 'POST', headers: {}, bodyText: body, contentType: 'application/json', dedupeKey: null });
  assert.notEqual(a1.eventId, a2.eventId);
  assert.equal(db.getInbox(inboxId).eventCount, 2);

  const bad = (() => {
    try {
      db.updateInbox(ws, inboxId, { dedupeMode: 'md5' });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(bad?.code, 'bad_dedupe_mode');

  const set = db.updateInbox(ws, inboxId, { dedupeMode: 'idempotency', dedupeHeader: 'idempotency-key' });
  assert.equal(set.dedupeMode, 'idempotency');

  const key = 'idem-abc';
  const b1 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    bodyText: body,
    contentType: 'application/json',
    dedupeKey: key,
  });
  const countAfter = db.getInbox(inboxId).eventCount;
  const b2 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    bodyText: '{"different":true}',
    contentType: 'application/json',
    dedupeKey: key,
  });
  assert.equal(b2.deduped, true);
  assert.equal(b2.eventId, b1.eventId);
  assert.equal(db.getInbox(inboxId).eventCount, countAfter, 'count must not bump on hit');
  assert.equal(b2.autoForwardTarget, null);

  // body-hash
  db.updateInbox(ws, inboxId, { dedupeMode: 'body-hash' });
  const hashKey = `sha256:${refHex}`;
  const c1 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: body,
    contentType: 'application/json',
    dedupeKey: hashKey,
  });
  const c2 = db.ingestEvent(inboxId, {
    method: 'PUT',
    headers: {},
    bodyText: body,
    contentType: 'application/json',
    dedupeKey: hashKey,
  });
  assert.equal(c2.deduped, true);
  assert.equal(c2.eventId, c1.eventId);
  const detail = db.getEvent(ws, c1.eventId);
  assert.equal(detail.dedupeKey, hashKey);

  // either prefers header
  db.updateInbox(ws, inboxId, { dedupeMode: 'either' });
  const e1 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: { 'idempotency-key': 'either-1' },
    bodyText: body,
    contentType: 'application/json',
    dedupeKey: 'either-1',
  });
  const e2 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: { 'idempotency-key': 'either-1' },
    bodyText: '{"x":1}',
    contentType: 'application/json',
    dedupeKey: 'either-1',
  });
  assert.equal(e2.eventId, e1.eventId);

  // missing header in idempotency mode stores both
  db.updateInbox(ws, inboxId, { dedupeMode: 'idempotency' });
  const m1 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: '{"m":1}',
    contentType: 'application/json',
    dedupeKey: null,
  });
  const m2 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: '{"m":1}',
    contentType: 'application/json',
    dedupeKey: null,
  });
  assert.notEqual(m1.eventId, m2.eventId);

  // custom response on hit uses original eventId
  db.updateInbox(ws, inboxId, {
    dedupeMode: 'body-hash',
    responseStatus: 202,
    responseBody: 'queued {{eventId}}',
  });
  const crBody = '{"cr":true}';
  const crKey = `sha256:${createHash('sha256').update(crBody).digest('hex')}`;
  const cr1 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: crBody,
    contentType: 'application/json',
    dedupeKey: crKey,
  });
  assert.equal(cr1.customResponse?.body, `queued ${cr1.eventId}`);
  const cr2 = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {},
    bodyText: crBody,
    contentType: 'application/json',
    dedupeKey: crKey,
  });
  assert.equal(cr2.deduped, true);
  assert.equal(cr2.customResponse?.body, `queued ${cr1.eventId}`);

  // list/export/csv
  const list = db.listEvents(ws, inboxId, { limit: 500 });
  assert.ok(list.some((e) => e.dedupeKey === hashKey));
  const exp = db.exportEvents(ws, inboxId, { limit: 500 });
  assert.ok(exp.events.some((e) => e.dedupeKey === hashKey));
  const csv = db.eventsToCsv(exp.raw);
  assert.ok(csv.split('\n')[0].endsWith(',dedupeKey'));
  assert.ok(csv.includes(hashKey));

  // clear
  const cleared = db.updateInbox(ws, inboxId, { dedupeMode: 'none', responseStatus: 0, responseBody: '' });
  assert.equal(cleared.dedupeMode, 'none');
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
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) };
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
assert.equal(created.inbox.dedupeMode, 'none');
const auth = { 'x-hookkeep-token': tok };
const patch = (b) =>
  call(`/api/inboxes/${inboxId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(b),
  });

const bad = await patch({ dedupeMode: 'md5' });
assert.equal(bad.status, 400);
assert.equal((await bad.json()).error, 'bad_dedupe_mode');

await patch({ dedupeMode: 'idempotency' });
const wBody = '{"w":1}';
const hit1 = await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': 'w-1' },
  body: wBody,
});
assert.equal(hit1.status, 200);
const j1 = await hit1.json();
const countBefore = (await (await call('/api/workspace', { headers: auth })).json()).inboxes[0].eventCount;

const hit2 = await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': 'w-1' },
  body: '{"w":2}',
});
assert.equal(hit2.headers.get('x-hookkeep-deduped'), '1');
assert.equal(hit2.headers.get('x-hookkeep-event-id'), j1.id);
const j2 = await hit2.json();
assert.equal(j2.deduped, true);
assert.equal(j2.eventId, j1.id);
assert.equal(j2.id, j1.id);
const countAfter = (await (await call('/api/workspace', { headers: auth })).json()).inboxes[0].eventCount;
assert.equal(countAfter, countBefore, 'workers count must not bump on hit');

// body-hash miss then hit
await patch({ dedupeMode: 'body-hash', responseStatus: 202, responseBody: 'q {{eventId}}' });
const bh = '{"bh":true}';
const r1 = await call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bh });
assert.equal(r1.status, 202);
const id1 = r1.headers.get('x-hookkeep-event-id');
assert.equal(await r1.text(), `q ${id1}`);
const r2 = await call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bh });
assert.equal(r2.status, 202);
assert.equal(r2.headers.get('x-hookkeep-deduped'), '1');
assert.equal(r2.headers.get('x-hookkeep-event-id'), id1);
assert.equal(await r2.text(), `q ${id1}`);

const detail = await (await call(`/api/events/${id1}`, { headers: auth })).json();
assert.ok(detail.event.dedupeKey && detail.event.dedupeKey.startsWith('sha256:'));
const csv = await (await call(`/api/inboxes/${inboxId}/events/export?format=csv`, { headers: auth })).text();
assert.ok(csv.split('\n')[0].includes('dedupeKey'));

console.log('DEDUPE UNIT OK');
