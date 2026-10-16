/** Unit: capture redaction — shared src/redact.js helpers, Node db path (temp data dir), Workers fetch path (KV mock). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REDACT_PLACEHOLDER,
  splitListInput,
  normalizeRedactHeaderName,
  normalizeRedactJsonPath,
  normalizeRedactPatch,
  publicRedactConfig,
  parseJsonPath,
  setJsonPath,
  redactHeadersCopy,
  redactJsonBody,
  applyCaptureRedaction,
  publicRedactionSummary,
} from '../src/redact.js';

// --- helpers
assert.equal(REDACT_PLACEHOLDER, '[REDACTED]');
assert.deepEqual(splitListInput('a, b\nc'), ['a', 'b', 'c']);
assert.deepEqual(splitListInput(['x', 'y']), ['x', 'y']);
assert.deepEqual(splitListInput(''), []);
assert.equal(normalizeRedactHeaderName('Authorization'), 'authorization');
assert.equal(normalizeRedactHeaderName('X-API-Key'), 'x-api-key');
assert.equal(normalizeRedactHeaderName('bad name!'), null);
assert.equal(normalizeRedactHeaderName('a'.repeat(81)), null);
assert.equal(normalizeRedactJsonPath('data.secret'), 'data.secret');
assert.equal(normalizeRedactJsonPath('items[0].token'), 'items[0].token');
assert.equal(normalizeRedactJsonPath('a b'), null);
assert.equal(normalizeRedactJsonPath('foo..bar'), null);
assert.equal(normalizeRedactJsonPath('hack;rm'), null);

{
  const ok = normalizeRedactPatch({
    redactHeaders: 'Authorization, x-api-key',
    redactJsonPaths: 'apiKey\ndata.secret',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch.redactHeaders, ['authorization', 'x-api-key']);
  assert.deepEqual(ok.patch.redactJsonPaths, ['apiKey', 'data.secret']);

  const badH = normalizeRedactPatch({ redactHeaders: 'not a header!' });
  assert.equal(badH.ok, false);
  assert.equal(badH.error, 'bad_redact_headers');

  const badP = normalizeRedactPatch({ redactJsonPaths: 'foo bar' });
  assert.equal(badP.ok, false);
  assert.equal(badP.error, 'bad_redact_json_paths');

  const tooMany = normalizeRedactPatch({ redactHeaders: Array.from({ length: 41 }, (_, i) => `h${i}`) });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, 'bad_redact_headers');
}

assert.deepEqual(publicRedactConfig({}), { redactHeaders: [], redactJsonPaths: [] });
assert.deepEqual(parseJsonPath('a.b[0].c'), ['a', 'b', 0, 'c']);
assert.deepEqual(parseJsonPath('[0].key'), [0, 'key']);

{
  const o = { data: { secret: 's3cr3t', keep: 1 }, items: [{ token: 't1' }, { token: 't2' }] };
  assert.equal(setJsonPath(o, 'data.secret'), true);
  assert.equal(o.data.secret, '[REDACTED]');
  assert.equal(o.data.keep, 1);
  assert.equal(setJsonPath(o, 'items[0].token'), true);
  assert.equal(o.items[0].token, '[REDACTED]');
  assert.equal(o.items[1].token, 't2');
  assert.equal(setJsonPath(o, 'missing.path'), false);
  assert.equal(setJsonPath(o, 'items[9].token'), false);
}

{
  const { headers, applied } = redactHeadersCopy(
    { Authorization: 'Bearer xyz', 'X-Other': '1', 'x-api-key': 'k' },
    ['authorization', 'x-api-key']
  );
  assert.equal(headers.Authorization, '[REDACTED]');
  assert.equal(headers['x-api-key'], '[REDACTED]');
  assert.equal(headers['X-Other'], '1');
  assert.deepEqual(applied.sort(), ['authorization', 'x-api-key']);
}

{
  const body = JSON.stringify({ apiKey: 'live_xxx', nested: { secret: 's', ok: true } });
  const r = redactJsonBody(body, 'application/json', ['apiKey', 'nested.secret']);
  assert.equal(r.parsed, true);
  assert.deepEqual(r.applied.sort(), ['apiKey', 'nested.secret']);
  const j = JSON.parse(r.bodyText);
  assert.equal(j.apiKey, '[REDACTED]');
  assert.equal(j.nested.secret, '[REDACTED]');
  assert.equal(j.nested.ok, true);
  const plain = redactJsonBody('not-json', 'text/plain', ['apiKey']);
  assert.equal(plain.parsed, false);
  assert.equal(plain.bodyText, 'not-json');
  assert.deepEqual(plain.applied, []);
}

{
  const out = applyCaptureRedaction(
    { redactHeaders: ['authorization'], redactJsonPaths: ['secret'] },
    {
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      bodyText: JSON.stringify({ secret: 'hide', n: 1 }),
      contentType: 'application/json',
      size: 30,
    }
  );
  assert.equal(out.headers.authorization, '[REDACTED]');
  assert.equal(out.bodyJson.secret, '[REDACTED]');
  assert.equal(out.bodyJson.n, 1);
  assert.ok(out.redaction);
  assert.deepEqual(out.redaction.headers, ['authorization']);
  assert.deepEqual(out.redaction.jsonPaths, ['secret']);
  assert.deepEqual(publicRedactionSummary({ redaction: out.redaction }), out.redaction);
  assert.equal(publicRedactionSummary({}), null);
}

// --- Node db path
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-redact-'));
process.env.HOOKKEEP_DATA = tmp;
const db = await import('../src/db.js');
{
  const { workspace, inbox } = db.createWorkspace({ email: 'redact-unit@example.com' });
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: workspace.id });
  const inboxId = inbox.id;
  assert.deepEqual(inbox.redactHeaders, []);
  assert.deepEqual(inbox.redactJsonPaths, []);

  let threw = null;
  try {
    db.updateInbox(ws, inboxId, { redactJsonPaths: 'bad path!' });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw?.code, 'bad_redact_json_paths');

  const updated = db.updateInbox(ws, inboxId, {
    redactHeaders: 'Authorization, X-Custom-Secret',
    redactJsonPaths: 'apiKey, nested.token',
  });
  assert.deepEqual(updated.redactHeaders, ['authorization', 'x-custom-secret']);
  assert.deepEqual(updated.redactJsonPaths, ['apiKey', 'nested.token']);

  const r = db.ingestEvent(inboxId, {
    method: 'POST',
    headers: {
      authorization: 'Bearer raw-secret',
      'x-custom-secret': 'shh',
      'content-type': 'application/json',
      'x-request-id': 'keep-me',
    },
    bodyText: JSON.stringify({ apiKey: 'live_abc', nested: { token: 't', keep: 1 }, status: 200 }),
    contentType: 'application/json',
  });
  assert.equal(r.ok, true);
  const ev = db.getEvent(ws, r.eventId);
  assert.equal(ev.headers.authorization, '[REDACTED]');
  assert.equal(ev.headers['x-custom-secret'], '[REDACTED]');
  assert.equal(ev.headers['x-request-id'], 'keep-me');
  assert.equal(ev.bodyJson.apiKey, '[REDACTED]');
  assert.equal(ev.bodyJson.nested.token, '[REDACTED]');
  assert.equal(ev.bodyJson.nested.keep, 1);
  assert.ok(String(ev.bodyText).includes('[REDACTED]'));
  assert.ok(!String(ev.bodyText).includes('live_abc'));
  assert.ok(ev.redaction);
  assert.ok(ev.redaction.headers.includes('authorization'));
  assert.ok(ev.redaction.jsonPaths.includes('apiKey'));

  const list = db.listEvents(ws, inboxId, { limit: 50 });
  assert.ok(list[0].redaction);
  const exp = db.exportEvents(ws, inboxId, { limit: 50 });
  assert.ok(exp.events[0].redaction);
  const csv = db.eventsToCsv(exp.raw);
  assert.ok(csv.split('\n')[0].includes('redactedHeaders'));
  assert.ok(csv.includes('authorization'));

  // clear
  const cleared = db.updateInbox(ws, inboxId, { redactHeaders: '', redactJsonPaths: [] });
  assert.deepEqual(cleared.redactHeaders, []);
  assert.deepEqual(cleared.redactJsonPaths, []);
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
  await call('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({ email: 'redact-w@example.com' }),
    headers: { 'content-type': 'application/json' },
  })
).json();
const tok = created.ownerToken;
const inboxId = created.inbox.id;
assert.deepEqual(created.inbox.redactHeaders, []);
const auth = { 'x-hookkeep-token': tok };
const patch = (b) =>
  call(`/api/inboxes/${inboxId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(b),
  });

const unauth = await call(`/api/inboxes/${inboxId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redactHeaders: ['authorization'] }),
});
assert.equal(unauth.status, 401);

const missing = await call('/api/inboxes/nope', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ redactHeaders: ['authorization'] }),
});
assert.equal(missing.status, 404);

const bad = await patch({ redactJsonPaths: 'not a path!!!' });
assert.equal(bad.status, 400);
assert.equal((await bad.json()).error, 'bad_redact_json_paths');

await patch({
  redactHeaders: ['authorization', 'x-hook-secret'],
  redactJsonPaths: ['password', 'user.email'],
});
const body = JSON.stringify({ password: 'hunter2', user: { email: 'a@b.c', name: 'Ada' }, n: 1 });
const hit = await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer raw',
    'x-hook-secret': 'shh',
    'x-request-id': 'rid-1',
  },
  body,
});
assert.equal(hit.status, 200);
const j = await hit.json();
const detail = await (await call(`/api/events/${j.id}`, { headers: auth })).json();
assert.equal(detail.event.headers.authorization, '[REDACTED]');
assert.equal(detail.event.headers['x-hook-secret'], '[REDACTED]');
assert.equal(detail.event.headers['x-request-id'], 'rid-1');
assert.equal(detail.event.bodyJson.password, '[REDACTED]');
assert.equal(detail.event.bodyJson.user.email, '[REDACTED]');
assert.equal(detail.event.bodyJson.user.name, 'Ada');
assert.ok(detail.event.redaction);
assert.ok(detail.event.redaction.headers.includes('authorization'));
assert.ok(detail.event.redaction.jsonPaths.includes('password'));

const csv = await (await call(`/api/inboxes/${inboxId}/events/export?format=csv`, { headers: auth })).text();
assert.ok(csv.split('\n')[0].includes('redactedHeaders'));

console.log('REDACT UNIT OK');
