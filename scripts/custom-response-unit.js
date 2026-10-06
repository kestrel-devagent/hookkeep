/** Unit: per-inbox custom ingest response — shared helper + Workers fetch path (KV mock, no server). */
import assert from 'node:assert/strict';
import {
  normalizeResponsePatch,
  buildCustomResponse,
  renderResponseTemplate,
  publicResponseConfig,
  RESPONSE_BODY_MAX,
} from '../src/custom-response.js';
import worker from '../workers/src/worker.js';

// --- normalizeResponsePatch
assert.deepEqual(normalizeResponsePatch({}).patch, {});
assert.equal(normalizeResponsePatch({ responseStatus: 503 }).patch.responseStatus, 503);
assert.equal(normalizeResponsePatch({ responseStatus: '418' }).patch.responseStatus, 418);
for (const off of [0, '0', null, '']) assert.equal(normalizeResponsePatch({ responseStatus: off }).patch.responseStatus, 0);
for (const bad of [199, 600, 99, 'abc', 200.5, -1]) {
  const r = normalizeResponsePatch({ responseStatus: bad });
  assert.equal(r.ok, false, `expected reject for ${bad}`);
  assert.equal(r.error, 'bad_response_status');
}
assert.equal(normalizeResponsePatch({ responseBody: 'x'.repeat(RESPONSE_BODY_MAX + 50) }).patch.responseBody.length, RESPONSE_BODY_MAX);
assert.equal(normalizeResponsePatch({ responseContentType: 'text/plain\r\nx-evil: 1' }).patch.responseContentType, 'text/plainx-evil: 1');
assert.deepEqual(publicResponseConfig({}), { responseStatus: 0, responseBody: '', responseContentType: '' });

// --- templates
const ev = { id: 'ev_1', method: 'POST', receivedAt: '2026-10-06T12:00:00.000Z', bodyJson: { challenge: 'c1', a: { b: 2 }, o: { k: 1 } } };
assert.equal(
  renderResponseTemplate('{{eventId}} {{method}} {{json.challenge}} {{json.a.b}} {{json.missing.x}} {{nope}} {{json.o}}', { ...ev, eventId: ev.id, json: ev.bodyJson }),
  'ev_1 POST c1 2   {"k":1}'
);

// --- buildCustomResponse
assert.equal(buildCustomResponse({}, ev), null);
assert.equal(buildCustomResponse({ responseStatus: 0, responseBody: 'x' }, ev), null);
assert.deepEqual(buildCustomResponse({ responseStatus: 204, responseBody: 'ignored' }, ev), { status: 204, contentType: '', body: null });
const j = buildCustomResponse({ responseStatus: 503, responseBody: '{"id":"{{eventId}}"}' }, ev);
assert.equal(j.status, 503);
assert.match(j.contentType, /^application\/json/);
assert.equal(j.body, '{"id":"ev_1"}');
const t = buildCustomResponse({ responseStatus: 200, responseBody: '{{json.challenge}}' }, ev);
assert.match(t.contentType, /^text\/plain/);
assert.equal(t.body, 'c1');
assert.equal(buildCustomResponse({ responseStatus: 200, responseBody: 'x', responseContentType: 'application/xml' }, ev).contentType, 'application/xml');

// --- Workers fetch path with a KV mock
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

const created = await (await call('/api/workspace', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
const tok = created.ownerToken;
const inboxId = created.inbox.id;
assert.ok(tok && inboxId, 'workspace create');
assert.equal(created.inbox.responseStatus, 0);
const patch = (body, auth = true) =>
  call(`/api/inboxes/${inboxId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-hookkeep-token': tok } : {}) },
    body: JSON.stringify(body),
  });

assert.equal((await patch({ responseStatus: 503 }, false)).status, 401);
const bad = await patch({ responseStatus: 700, name: 'nope' });
assert.equal(bad.status, 400);
assert.equal((await bad.json()).error, 'bad_response_status');
const set = await (await patch({ responseStatus: 503, responseBody: '{"retry":"{{eventId}}"}' })).json();
assert.equal(set.inbox.responseStatus, 503);
assert.notEqual(set.inbox.name, 'nope');

const r503 = await call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
assert.equal(r503.status, 503);
const evId = r503.headers.get('x-hookkeep-event-id');
assert.ok(evId && evId.startsWith('ev_'));
assert.equal(await r503.text(), `{"retry":"${evId}"}`);
const list = await (await call(`/api/inboxes/${inboxId}/events`, { headers: { 'x-hookkeep-token': tok } })).json();
const row = list.events.find((e) => e.id === evId);
assert.ok(row && row.respondedStatus === 503 && row.respondedCustom === true, 'Workers event records respondedStatus');

await patch({ responseStatus: 200, responseBody: '{{json.challenge}}', responseContentType: 'text/plain' });
const rc = await call(`/hook/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"challenge":"wk_chal"}' });
assert.equal(rc.status, 200);
assert.equal(await rc.text(), 'wk_chal');

await patch({ responseStatus: 0 });
const rd = await call(`/hook/${inboxId}`, { method: 'POST', body: '{"d":1}', headers: { 'content-type': 'application/json' } });
assert.equal(rd.status, 200);
const rdJson = await rd.json();
assert.equal(rdJson.ok, true);
assert.equal(rdJson.received, true);

console.log('CUSTOM-RESPONSE UNIT OK');
