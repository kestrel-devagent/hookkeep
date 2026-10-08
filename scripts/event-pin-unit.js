/** Unit: event pins + notes — shared src/event-pin.js, Node db path (temp data dir), Workers fetch path (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizePinPatch,
  applyPinPatch,
  pinnedFilterMatch,
  rowsToTrim,
  PIN_LIMITS,
  NOTE_MAX,
} from '../src/event-pin.js';

// --- helpers
assert.deepEqual(normalizePinPatch({ pinned: true }), { ok: true, patch: { pinned: true } });
assert.equal(normalizePinPatch({ pinned: 'yes' }).error, 'bad_pinned');
assert.equal(normalizePinPatch({ note: 5 }).error, 'bad_note');
assert.equal(normalizePinPatch({ note: 'x'.repeat(NOTE_MAX + 1) }).error, 'bad_note');
assert.equal(normalizePinPatch({}).error, 'empty_patch');
assert.equal(normalizePinPatch(null).error, 'empty_patch');
assert.deepEqual(normalizePinPatch({ note: null }).patch, { note: '' });
assert.deepEqual(normalizePinPatch({ note: '  repro  ' }).patch, { note: 'repro' });
{
  const ev = { id: 'ev_a' };
  assert.equal(applyPinPatch(ev, { pinned: true }, { pinnedCount: 5, limit: 5 }).error, 'pin_limit');
  assert.equal(ev.pinned, undefined, 'limit error applies nothing');
  const r = applyPinPatch(ev, { pinned: true, note: 'n' }, { pinnedCount: 4, limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.changedPin, true);
  assert.equal(ev.pinned, true);
  assert.ok(ev.pinnedAt);
  assert.equal(ev.note, 'n');
  // already pinned + at limit → note edit still OK
  assert.equal(applyPinPatch(ev, { pinned: true, note: 'm' }, { pinnedCount: 5, limit: 5 }).ok, true);
  applyPinPatch(ev, { pinned: false, note: '' });
  assert.equal(ev.pinned, undefined);
  assert.equal(ev.pinnedAt, undefined);
  assert.equal(ev.note, undefined);
}
assert.equal(pinnedFilterMatch({ pinned: true }, '1'), true);
assert.equal(pinnedFilterMatch({}, '1'), false);
assert.equal(pinnedFilterMatch({}, '0'), true);
assert.equal(pinnedFilterMatch({ pinned: true }, 'false'), false);
assert.equal(pinnedFilterMatch({}, ''), true);
{
  const rows = [{ id: 1 }, { id: 2, pinned: true }, { id: 3 }, { id: 4 }, { id: 5, pinned: true }];
  assert.deepEqual(rowsToTrim(rows, 2).map((r) => r.id), [4], 'pinned exempt + not counted');
  assert.deepEqual(rowsToTrim(rows, 0).map((r) => r.id), [1, 3, 4]);
}
assert.equal(PIN_LIMITS.free, 5);

// --- Node db path (isolated temp data dir)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-pin-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const { workspace, inbox } = db.createWorkspace({ email: 'pin-unit@example.com' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: workspace.id });
  const first = db.ingestEvent(inbox.id, { method: 'POST', headers: {}, bodyText: '{"n":0}', contentType: 'application/json' });
  assert.equal(db.updateEventPin(ws, 'ev_missing', { pinned: true }), null);
  assert.equal(db.updateEventPin(ws, first.eventId, { pinned: 1 }).error, 'bad_pinned');
  const p = db.updateEventPin(ws, first.eventId, { pinned: true, note: 'keep me' });
  assert.equal(p.ok, true);
  assert.equal(p.pinnedCount, 1);
  assert.equal(p.pinLimit, 5);
  // Fill past the free keep window (50) — the pinned first event must survive
  for (let i = 1; i <= 55; i++) {
    // distinct receivedAt ordering
    await new Promise((r) => setTimeout(r, 1));
    db.ingestEvent(inbox.id, { method: 'POST', headers: {}, bodyText: `{"n":${i}}`, contentType: 'application/json' });
  }
  const all = db.listEvents(ws, inbox.id, { limit: 500 });
  assert.equal(all.length, 51, `50 unpinned + 1 pinned kept, got ${all.length}`);
  assert.ok(all.some((e) => e.id === first.eventId && e.pinned && e.note === 'keep me'), 'pinned survived trim');
  const onlyPinned = db.listEvents(ws, inbox.id, { pinned: '1' });
  assert.deepEqual(onlyPinned.map((e) => e.id), [first.eventId]);
  assert.equal(db.listEvents(ws, inbox.id, { pinned: '0', limit: 500 }).length, 50);
  // pin limit
  const unp = all.filter((e) => !e.pinned).slice(0, 5);
  for (const e of unp.slice(0, 4)) assert.equal(db.updateEventPin(ws, e.id, { pinned: true }).ok, true);
  const over = db.updateEventPin(ws, unp[4].id, { pinned: true });
  assert.equal(over.error, 'pin_limit');
  assert.equal(over.limit, 5);
  // bulk delete skips pinned unless includePinned
  const del = db.deleteEventsBulk(ws, inbox.id, { q: '', limit: 50, confirm: true });
  assert.equal(del.deleted, 46, `deleted ${del.deleted}`);
  const left = db.listEvents(ws, inbox.id, { limit: 500 });
  assert.equal(left.length, 5);
  assert.ok(left.every((e) => e.pinned));
  // export + CSV carry pin/note
  const exp = db.exportEvents(ws, inbox.id, { pinned: '1' });
  assert.ok(exp.events.some((e) => e.pinned === true && e.note === 'keep me'));
  const csv = db.eventsToCsv(exp.raw);
  assert.ok(csv.split('\n')[0].endsWith(',pinned,note'));
  assert.ok(csv.includes(',true,keep me'));
  const delAll = db.deleteEventsBulk(ws, inbox.id, { confirm: true, includePinned: true });
  assert.equal(delAll.deleted, 5);
  assert.equal(delAll.filters.includePinned, true);
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
const auth = { 'x-hookkeep-token': created.ownerToken, 'content-type': 'application/json' };
const inboxId = created.inbox.id;
assert.equal(created.workspace.limits.maxPinned, 5);
const hook = (n) => call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }) });
const firstRes = await (await hook(0)).json();
const firstId = firstRes.eventId || firstRes.id;
assert.ok(firstId, JSON.stringify(firstRes));
const patchEv = (id, b) => call(`/api/events/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(b) });
assert.equal((await patchEv(firstId, {})).status, 400);
assert.equal((await patchEv('ev_nope', { pinned: true })).status, 404);
assert.equal((await call(`/api/events/${firstId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"pinned":true}' })).status, 401);
const pr = await patchEv(firstId, { pinned: true, note: 'stripe retry storm' });
assert.equal(pr.status, 200);
const prJson = await pr.json();
assert.equal(prJson.event.pinned, true);
assert.equal(prJson.pinnedCount, 1);
for (let i = 1; i <= 53; i++) {
  await new Promise((r) => setTimeout(r, 1));
  await hook(i);
}
const listAll = await (await call(`/api/inboxes/${inboxId}/events?limit=500`, { headers: auth })).json();
assert.equal(listAll.events.length, 51, `workers kept ${listAll.events.length}`);
assert.ok(listAll.events.some((e) => e.id === firstId && e.pinned && e.note === 'stripe retry storm'), 'workers pinned survived trim');
const listPinned = await (await call(`/api/inboxes/${inboxId}/events?pinned=1`, { headers: auth })).json();
assert.deepEqual(listPinned.events.map((e) => e.id), [firstId]);
const others = listAll.events.filter((e) => !e.pinned);
for (const e of others.slice(0, 4)) assert.equal((await patchEv(e.id, { pinned: true })).status, 200);
const lim = await patchEv(others[4].id, { pinned: true });
assert.equal(lim.status, 409);
assert.equal((await lim.json()).error, 'pin_limit');
const csv = await (await call(`/api/inboxes/${inboxId}/events/export?format=csv&pinned=1`, { headers: auth })).text();
assert.ok(csv.split('\n')[0].endsWith(',pinned,note'));
assert.equal(csv.trim().split('\n').length, 6, 'header + 5 pinned');
const del = await (await call(`/api/inboxes/${inboxId}/events/delete-bulk`, { method: 'POST', headers: auth, body: JSON.stringify({ confirm: true }) })).json();
assert.equal(del.deleted, 46, `workers deleted ${del.deleted}`);
const unpin = await (await patchEv(firstId, { pinned: false })).json();
assert.equal(unpin.event.pinned, undefined);
assert.equal(unpin.pinnedCount, 4);
assert.deepEqual(JSON.parse(kv.m.get(`pins:${inboxId}`)).includes(firstId), false);
const delAll = await (await call(`/api/inboxes/${inboxId}/events/delete-bulk`, { method: 'POST', headers: auth, body: JSON.stringify({ confirm: true, includePinned: true }) })).json();
assert.equal(delAll.deleted, 5);
assert.deepEqual(JSON.parse(kv.m.get(`pins:${inboxId}`)), []);

console.log('EVENT-PIN UNIT OK');
