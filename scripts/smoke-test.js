/** Local smoke test against a running server (default http://127.0.0.1:8787)
 * Steps: create → ingest → list → forwardUrl → replay → auto-forward → demo unlock → pro alerts → free tier
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HOOKKEEP_URL || 'http://127.0.0.1:8787';
const DATA_DIR =
  process.env.HOOKKEEP_DATA ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ALERTS_PATH = path.join(DATA_DIR, 'alerts.ndjson');

let STEP = 'boot';
function step(name) {
  STEP = name;
  console.log(`\n— ${name}`);
}
function fail(msg) {
  console.error(`\nSMOKE FAILED at step "${STEP}": ${msg}`);
  process.exit(1);
}
const check = (cond, msg) => { if (!cond) fail(msg); };

function alertLines() {
  try {
    return fs.readFileSync(ALERTS_PATH, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  // Tiny local catcher to receive replay forwards + notify webhook POSTs
  const caught = [];
  const catcher = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      caught.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => catcher.listen(0, '127.0.0.1', r));
  const catcherBase = `http://127.0.0.1:${catcher.address().port}`;
  const catcherUrl = `${catcherBase}/notify`;
  const replayUrl = `${catcherBase}/replay-target`;

  step('health');
  const healthRes = await fetch(`${BASE}/api/health`);
  const health = await healthRes.json();
  console.log('health', health);
  check(healthRes.ok && health.ok, 'health not ok');
  check(health.persistOk === true, 'persistOk false — data dir not writable');

  step('subscribe CTA is not 404');
  const sub = await fetch(`${BASE}/subscribe?product=hookkeep`, { redirect: 'manual' });
  check(sub.status !== 404, `/subscribe returned 404`);
  console.log('/subscribe status', sub.status, sub.headers.get('location') || '(html page)');

  step('create workspace');
  const created = await fetch(`${BASE}/api/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', label: 'Smoke' }),
  }).then((r) => r.json());
  check(created.ownerToken && created.inbox?.id, 'workspace create failed');
  console.log('workspace', created.workspace.id, 'inbox', created.inbox.id);

  const hook = `${BASE}/hook/${created.inbox.id}`;
  const auth = { 'x-hookkeep-token': created.ownerToken, 'content-type': 'application/json' };

  step('ingest event');
  const ingest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test': '1' },
    body: JSON.stringify({ event: 'payment.failed', status: 'error', amount: 900 }),
  }).then((r) => r.json());
  console.log('ingest', ingest);
  check(ingest.ok && ingest.id, 'ingest failed');

  step('list events');
  const events = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  console.log('events', events.events.length, events.events[0]?.statusGuess);
  check(events.events.length >= 1, 'no events listed');

  step('ingest GET + numeric status for filters');
  const ingestGet = await fetch(hook + '?probe=1', {
    method: 'GET',
    headers: { 'x-test': 'filter' },
  }).then((r) => r.json());
  check(ingestGet.ok && ingestGet.id, 'GET ingest failed');
  const ingest400 = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'http.out', status: 502, msg: 'upstream' }),
  }).then((r) => r.json());
  check(ingest400.ok && ingest400.id, 'status 502 ingest failed');

  step('filter events q=payment');
  const byQ = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events?q=${encodeURIComponent('payment')}`,
    { headers: { 'x-hookkeep-token': created.ownerToken } }
  ).then((r) => r.json());
  check(byQ.events.some((e) => e.id === ingest.id), 'q=payment missed payment event');
  check(!byQ.events.some((e) => e.id === ingest400.id), 'q=payment should exclude 502 event');

  step('filter events method=GET');
  const byMethod = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events?method=GET`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  check(byMethod.events.every((e) => e.method === 'GET'), 'method=GET leaked non-GET');
  check(byMethod.events.some((e) => e.id === ingestGet.id), 'method=GET missed GET event');

  step('filter events statusMin=500');
  const byStatus = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events?statusMin=500`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  check(byStatus.events.every((e) => Number(e.statusGuess) >= 500), 'statusMin=500 leaked lower');
  check(byStatus.events.some((e) => e.id === ingest400.id), 'statusMin=500 missed 502 event');

  step('filter events method=POST&statusMin=500 combined');
  const byCombo = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events?method=POST&statusMin=500`,
    { headers: { 'x-hookkeep-token': created.ownerToken } }
  ).then((r) => r.json());
  check(
    byCombo.events.every((e) => e.method === 'POST' && Number(e.statusGuess) >= 500),
    'combined filter leaked'
  );
  check(byCombo.events.some((e) => e.id === ingest400.id), 'combined filter missed 502 POST');
  check(!byCombo.events.some((e) => e.id === ingestGet.id), 'combined filter should exclude GET');

  step('replay without forwardUrl → no_forward_url');
  const noFwd = await fetch(`${BASE}/api/events/${ingest.id}/replay`, {
    method: 'POST',
    headers: auth,
    body: '{}',
  }).then((r) => r.json());
  check(noFwd.error === 'no_forward_url', `expected no_forward_url, got ${JSON.stringify(noFwd)}`);

  step('set forwardUrl to local catcher');
  const patch = await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ forwardUrl: replayUrl }),
  }).then((r) => r.json());
  check(patch.inbox?.forwardUrl === replayUrl, 'forwardUrl not saved');

  step('replay → catcher got body');
  const caughtBefore = caught.length;
  const replay = await fetch(`${BASE}/api/events/${ingest.id}/replay`, {
    method: 'POST',
    headers: auth,
    body: '{}',
  }).then((r) => r.json());
  console.log('replay', replay.ok, replay.status, `${replay.ms}ms`);
  check(replay.ok === true && replay.status === 200, `replay failed: ${JSON.stringify(replay)}`);
  check(caught.length === caughtBefore + 1, 'catcher did not receive replay');
  check(caught[caught.length - 1].body.includes('payment.failed'), 'catcher body mismatch');

  step('auto-forward on ingest (free tier OK)');
  const afPatch = await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ forwardUrl: replayUrl, autoForward: true }),
  }).then((r) => r.json());
  check(afPatch.inbox?.autoForward === true, 'autoForward not saved');
  check(afPatch.inbox?.forwardUrl === replayUrl, 'autoForward forwardUrl cleared');
  const afCaughtBefore = caught.length;
  const afIngest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test': 'auto-forward' },
    body: JSON.stringify({ event: 'auto.forward.probe', ping: true }),
  }).then((r) => r.json());
  console.log('auto-forward ingest', afIngest);
  check(afIngest.ok && afIngest.id, 'auto-forward ingest failed');
  check(afIngest.autoForward?.attempted === true, 'autoForward attempted missing on ingest response');
  check(afIngest.autoForward?.ok === true, `autoForward not ok: ${JSON.stringify(afIngest.autoForward)}`);
  check(caught.length === afCaughtBefore + 1, 'catcher did not receive auto-forward');
  check(
    caught[caught.length - 1].body.includes('auto.forward.probe'),
    'auto-forward catcher body mismatch'
  );
  const afEvent = await fetch(`${BASE}/api/events/${afIngest.id}`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  check(afEvent.event?.autoForward?.ok === true, 'event.autoForward not persisted');
  check(afEvent.event?.autoForward?.target === replayUrl, 'event.autoForward.target mismatch');
  console.log('auto-forward event field', afEvent.event.autoForward);

  step('demo unlock → paid');
  const unlock = await fetch(`${BASE}/api/unlock`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: 'HOOKKEEP-PRO-DEMO01' }),
  }).then((r) => r.json());
  check(unlock.workspace?.tier === 'paid', `unlock failed: ${JSON.stringify(unlock)}`);
  console.log('tier', unlock.workspace.tier);

  step('pro alerts (keyword + status)');
  await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ alertKeyword: 'failed', notifyWebhookUrl: catcherUrl }),
  }).then((r) => r.json());

  const before = alertLines();

  const kwIngest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'payment.failed', amount: 900 }),
  }).then((r) => r.json());
  console.log('keyword ingest alert', kwIngest.alert);

  const stIngest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 500, event: 'upstream.broken' }),
  }).then((r) => r.json());
  console.log('status ingest alert', stIngest.alert);

  const proAlertLines = alertLines() - before;
  check(kwIngest.alert?.matched === true && kwIngest.alert?.reason === 'keyword', 'keyword alert missing');
  check(stIngest.alert?.matched === true && stIngest.alert?.reason === 'status', 'status alert missing');
  check(proAlertLines >= 2, `expected ≥2 new alert lines, got ${proAlertLines}`);
  const notifyCaught = caught.filter((c) => c.url === '/notify');
  check(notifyCaught.length >= 2 && notifyCaught[0].body.includes('Hookkeep alert'),
    `notify webhook caught ${notifyCaught.length}`);
  console.log('alerts.ndjson +', proAlertLines, 'lines; notify webhook caught:', notifyCaught.length);

  step('alerts list endpoint');
  const alerts = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/alerts`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  check(Array.isArray(alerts.alerts) && alerts.alerts.length >= 2, 'alerts list missing records');

  step('free tier never alerts');
  const free = await fetch(`${BASE}/api/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'free@example.com', label: 'Free smoke' }),
  }).then((r) => r.json());
  await fetch(`${BASE}/api/inboxes/${free.inbox.id}`, {
    method: 'PATCH',
    headers: { 'x-hookkeep-token': free.ownerToken, 'content-type': 'application/json' },
    body: JSON.stringify({ alertKeyword: 'failed', notifyWebhookUrl: catcherUrl }),
  }).then((r) => r.json());
  const freeBefore = alertLines();
  const freeIngest = await fetch(`${BASE}/hook/${free.inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'payment.failed', status: 500 }),
  }).then((r) => r.json());
  check(!freeIngest.alert && alertLines() === freeBefore, 'free tier fired an alert');
  console.log('free-tier ingest alert:', freeIngest.alert ?? null, '(expect null)');

  step('waitlist');
  const wait = await fetch(`${BASE}/api/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'wait@example.com', note: 'smoke' }),
  }).then((r) => r.json());
  check(wait.ok, 'waitlist failed');
  console.log('waitlist', wait.message);

  catcher.close();
  console.log('\nSMOKE OK');
}

main().catch((e) => {
  console.error(`\nSMOKE FAILED at step "${STEP}":`, e);
  process.exit(1);
});
