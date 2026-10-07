/** Unit: per-inbox webhook signature verification — shared src/signature.js + Workers fetch path (KV mock, no server). */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  normalizeSignaturePatch,
  publicSignatureConfig,
  verifySignature,
  parseStripeHeader,
  timingSafeEqualStr,
  maskSecret,
  SIGNING_SECRET_MAX,
} from '../src/signature.js';
import worker from '../workers/src/worker.js';

// Reference HMAC via node:crypto (independent of the WebCrypto path under test)
const ref = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

// --- normalizeSignaturePatch
assert.deepEqual(normalizeSignaturePatch({}).patch, {});
for (const s of ['none', 'stripe', 'github', 'hmac-sha256', 'STRIPE']) {
  assert.equal(normalizeSignaturePatch({ signingScheme: s }).ok, true, s);
}
assert.equal(normalizeSignaturePatch({ signingScheme: null }).patch.signingScheme, 'none');
for (const bad of ['md5', 'sha1', 'hmac', 42]) {
  const r = normalizeSignaturePatch({ signingScheme: bad });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_signing_scheme');
}
assert.equal(normalizeSignaturePatch({ signingSecret: 'x'.repeat(SIGNING_SECRET_MAX + 1) }).error, 'bad_signing_secret');
assert.equal(normalizeSignaturePatch({ signingSecret: null }).patch.signingSecret, '');
assert.equal(normalizeSignaturePatch({ signingHeader: ' X-My-Sig ' }).patch.signingHeader, 'x-my-sig');
assert.equal(normalizeSignaturePatch({ signingHeader: 'bad header\r\n' }).error, 'bad_signing_header');

// --- public view never leaks the secret
const longSecret = 'whsec_test_ABCDEFGHIJKLMNOP1234';
const pub = publicSignatureConfig({ signingScheme: 'stripe', signingSecret: longSecret });
assert.equal(pub.hasSigningSecret, true);
assert.equal(pub.signingSecretHint, '••••1234');
assert.ok(!JSON.stringify(pub).includes(longSecret.slice(0, -4)));
assert.equal(maskSecret('short'), '••••');
assert.deepEqual(publicSignatureConfig({}), { signingScheme: 'none', signingHeader: '', hasSigningSecret: false, signingSecretHint: '' });
assert.equal(publicSignatureConfig({ signingScheme: 'hmac-sha256' }).signingHeader, 'x-signature');

// --- helpers
assert.equal(timingSafeEqualStr('abc', 'abc'), true);
assert.equal(timingSafeEqualStr('abc', 'abd'), false);
assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
assert.equal(parseStripeHeader('v1=' + 'a'.repeat(64)), null);
assert.equal(parseStripeHeader('t=1,v1=nothex'), null);
assert.deepEqual(parseStripeHeader(`t=12, v1=${'A'.repeat(64)}, v0=zz`), { t: 12, v1: ['a'.repeat(64)] });

// --- Stripe
const body = '{"id":"evt_1","type":"invoice.paid","amount":900,"note":"caf\u00e9 ✓"}';
const nowMs = 1_790_000_000_000;
const t = Math.floor(nowMs / 1000) - 12;
const stripeInbox = { signingScheme: 'stripe', signingSecret: longSecret };
const stripeSig = ref(longSecret, `${t}.${body}`);
let r = await verifySignature(stripeInbox, { headers: { 'stripe-signature': `t=${t},v1=${stripeSig}` }, rawBody: body, nowMs });
assert.deepEqual({ v: r.valid, reason: r.reason, skew: r.timestampSkewSec, scheme: r.scheme }, { v: true, reason: 'ok', skew: 12, scheme: 'stripe' });
// raw bytes (Uint8Array) give the same answer as the string
r = await verifySignature(stripeInbox, { headers: { 'Stripe-Signature': `t=${t},v1=${stripeSig}` }, rawBody: new TextEncoder().encode(body), nowMs });
assert.equal(r.valid, true);
// tampered body
r = await verifySignature(stripeInbox, { headers: { 'stripe-signature': `t=${t},v1=${stripeSig}` }, rawBody: body.replace('900', '1'), nowMs });
assert.equal(r.valid, false);
assert.equal(r.reason, 'mismatch');
// expired (valid HMAC but old t)
const oldT = Math.floor(nowMs / 1000) - 301;
r = await verifySignature(stripeInbox, { headers: { 'stripe-signature': `t=${oldT},v1=${ref(longSecret, `${oldT}.${body}`)}` }, rawBody: body, nowMs });
assert.equal(r.valid, false);
assert.equal(r.reason, 'timestamp_out_of_tolerance');
assert.equal(r.timestampSkewSec, 301);
// multiple v1 (secret rotation): one wrong + one right
r = await verifySignature(stripeInbox, { headers: { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)},v1=${stripeSig}` }, rawBody: body, nowMs });
assert.equal(r.valid, true);
assert.equal(r.reason, 'ok');
r = await verifySignature(stripeInbox, { headers: {}, rawBody: body, nowMs });
assert.equal(r.reason, 'missing_header');
r = await verifySignature(stripeInbox, { headers: { 'stripe-signature': 'garbage' }, rawBody: body, nowMs });
assert.equal(r.reason, 'bad_format');
r = await verifySignature({ signingScheme: 'stripe' }, { headers: { 'stripe-signature': `t=${t},v1=${stripeSig}` }, rawBody: body, nowMs });
assert.equal(r.reason, 'no_secret');
assert.equal(await verifySignature({ signingScheme: 'none', signingSecret: 'x' }, { headers: {}, rawBody: body }), null);
assert.equal(await verifySignature({}, { headers: {}, rawBody: body }), null);

// --- GitHub
const ghSecret = 'gh-hook-secret-0001';
const ghInbox = { signingScheme: 'github', signingSecret: ghSecret };
r = await verifySignature(ghInbox, { headers: { 'x-hub-signature-256': `sha256=${ref(ghSecret, body)}` }, rawBody: body });
assert.deepEqual([r.valid, r.reason, r.scheme], [true, 'ok', 'github']);
r = await verifySignature(ghInbox, { headers: { 'x-hub-signature-256': `sha256=${ref('wrong', body)}` }, rawBody: body });
assert.deepEqual([r.valid, r.reason], [false, 'mismatch']);
r = await verifySignature(ghInbox, { headers: { 'x-hub-signature': 'sha1=abc' }, rawBody: body });
assert.deepEqual([r.valid, r.reason], [false, 'missing_header']);
r = await verifySignature(ghInbox, { headers: { 'x-hub-signature-256': ref(ghSecret, body) }, rawBody: body });
assert.equal(r.reason, 'bad_format', 'github requires sha256= prefix');

// --- generic hmac-sha256 with a custom header (hex or sha256=hex)
const hSecret = 'generic-secret-xyz';
const hInbox = { signingScheme: 'hmac-sha256', signingSecret: hSecret, signingHeader: 'x-acme-signature' };
r = await verifySignature(hInbox, { headers: { 'x-acme-signature': ref(hSecret, body) }, rawBody: body });
assert.deepEqual([r.valid, r.reason, r.header], [true, 'ok', 'x-acme-signature']);
r = await verifySignature(hInbox, { headers: { 'x-acme-signature': `sha256=${ref(hSecret, body).toUpperCase()}` }, rawBody: body });
assert.equal(r.valid, true);
r = await verifySignature(hInbox, { headers: { 'x-signature': ref(hSecret, body) }, rawBody: body });
assert.equal(r.reason, 'missing_header', 'custom header honored (default x-signature ignored)');
r = await verifySignature({ signingScheme: 'hmac-sha256', signingSecret: hSecret }, { headers: { 'x-signature': ref(hSecret, body) }, rawBody: body });
assert.equal(r.valid, true, 'default header x-signature');
r = await verifySignature(hInbox, { headers: { 'x-acme-signature': 'zz' }, rawBody: body });
assert.equal(r.reason, 'bad_format');

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
assert.equal(created.inbox.signingScheme, 'none');
assert.equal(created.inbox.hasSigningSecret, false);
const auth = { 'x-hookkeep-token': tok };
const patch = (b) =>
  call(`/api/inboxes/${inboxId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(b) });

const bad = await patch({ signingScheme: 'md5', name: 'nope', responseStatus: 503 });
assert.equal(bad.status, 400);
assert.equal((await bad.json()).error, 'bad_signing_scheme');
const wsAfterBad = await (await call('/api/workspace', { headers: auth })).json();
assert.notEqual(wsAfterBad.inboxes[0].name, 'nope', 'bad patch not applied');
assert.equal(wsAfterBad.inboxes[0].responseStatus, 0, 'bad patch not applied (response)');

const set = await (await patch({ signingScheme: 'github', signingSecret: ghSecret })).json();
assert.equal(set.inbox.signingScheme, 'github');
assert.equal(set.inbox.hasSigningSecret, true);
assert.equal(set.inbox.signingSecretHint, '••••0001');
const wsJson = JSON.stringify(await (await call('/api/workspace', { headers: auth })).json());
assert.ok(!wsJson.includes(ghSecret), 'secret leaked in GET /api/workspace');
assert.ok(!JSON.stringify(set).includes(ghSecret), 'secret leaked in PATCH response');

const good = await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${ref(ghSecret, body)}` },
  body,
});
assert.equal(good.status, 200);
const goodJson = await good.json();
assert.equal(goodJson.ok, true, 'ingest response unchanged');
assert.equal(goodJson.signature, undefined, 'ingest response does not expose signature');
const badHook = await call(`/hook/${inboxId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${ref('nope', body)}` },
  body,
});
assert.equal(badHook.status, 200, 'invalid signature still captured + same ack');
const badId = (await badHook.json()).id;

const list = await (await call(`/api/inboxes/${inboxId}/events`, { headers: auth })).json();
const gRow = list.events.find((e) => e.id === goodJson.id);
const bRow = list.events.find((e) => e.id === badId);
assert.deepEqual([gRow.signature.valid, gRow.signature.reason, gRow.signature.scheme], [true, 'ok', 'github']);
assert.deepEqual([bRow.signature.valid, bRow.signature.reason], [false, 'mismatch']);
const onlyInvalid = await (await call(`/api/inboxes/${inboxId}/events?sig=invalid`, { headers: auth })).json();
assert.deepEqual(onlyInvalid.events.map((e) => e.id), [badId]);
const detail = await (await call(`/api/events/${badId}`, { headers: auth })).json();
assert.equal(detail.event.signature.reason, 'mismatch');
assert.ok(!JSON.stringify(detail).includes(ghSecret), 'secret leaked in event detail');
const csv = await (await call(`/api/inboxes/${inboxId}/events/export?format=csv`, { headers: auth })).text();
const csvLines = csv.trim().split('\n');
assert.ok(csvLines[0].endsWith(',signatureValid,signatureReason'), csvLines[0]);
assert.ok(csvLines.some((l) => l.endsWith(',false,mismatch')) && csvLines.some((l) => l.endsWith(',true,ok')));
const ej = await (await call(`/api/inboxes/${inboxId}/events/export?format=json`, { headers: auth })).json();
assert.ok(ej.events.every((e) => e.signature && typeof e.signature.valid === 'boolean'));

// custom response still applies with signature checking on
await patch({ responseStatus: 202, responseBody: 'queued {{eventId}}' });
const cr = await call(`/hook/${inboxId}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
assert.equal(cr.status, 202);
const crId = cr.headers.get('x-hookkeep-event-id');
assert.equal(await cr.text(), `queued ${crId}`);
const crDetail = await (await call(`/api/events/${crId}`, { headers: auth })).json();
assert.equal(crDetail.event.signature.reason, 'missing_header');

// clear secret / scheme
const cleared = await (await patch({ signingScheme: 'none', signingSecret: '' })).json();
assert.equal(cleared.inbox.hasSigningSecret, false);
assert.equal(cleared.inbox.signingScheme, 'none');

console.log('SIGNATURE UNIT OK');
