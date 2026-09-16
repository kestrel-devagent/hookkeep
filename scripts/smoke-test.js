/** Local smoke test against a running server (default http://127.0.0.1:8787) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HOOKKEEP_URL || 'http://127.0.0.1:8787';
const DATA_DIR =
  process.env.HOOKKEEP_DATA ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ALERTS_PATH = path.join(DATA_DIR, 'alerts.ndjson');

function alertLines() {
  try {
    return fs.readFileSync(ALERTS_PATH, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  // Tiny local catcher to receive notify webhook POSTs
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
  const catcherUrl = `http://127.0.0.1:${catcher.address().port}/notify`;

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log('health', health);

  const created = await fetch(`${BASE}/api/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', label: 'Smoke' }),
  }).then((r) => r.json());
  console.log('workspace', created.workspace.id, 'inbox', created.inbox.id);

  const hook = `${BASE}/hook/${created.inbox.id}`;
  const ingest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test': '1' },
    body: JSON.stringify({ event: 'payment.failed', status: 'error', amount: 900 }),
  }).then((r) => r.json());
  console.log('ingest', ingest);

  const events = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events`, {
    headers: { 'x-hookkeep-token': created.ownerToken },
  }).then((r) => r.json());
  console.log('events', events.events.length, events.events[0]?.statusGuess);

  const unlock = await fetch(`${BASE}/api/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hookkeep-token': created.ownerToken },
    body: JSON.stringify({ code: 'HOOKKEEP-PRO-DEMO01' }),
  }).then((r) => r.json());
  console.log('unlock', unlock.workspace?.tier);

  // ---- Pro alerts ----
  const auth = { 'x-hookkeep-token': created.ownerToken, 'content-type': 'application/json' };
  await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ alertKeyword: 'failed', notifyWebhookUrl: catcherUrl }),
  }).then((r) => r.json());

  const before = alertLines();

  // 1) keyword match
  const kwIngest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'payment.failed', amount: 900 }),
  }).then((r) => r.json());
  console.log('keyword ingest alert', kwIngest.alert);

  // 2) status >= 400 match (no keyword in body)
  const stIngest = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 500, event: 'upstream.broken' }),
  }).then((r) => r.json());
  console.log('status ingest alert', stIngest.alert);

  const proAlertLines = alertLines() - before;
  const kwOk = kwIngest.alert?.matched === true && kwIngest.alert?.reason === 'keyword';
  const stOk = stIngest.alert?.matched === true && stIngest.alert?.reason === 'status';
  const hookOk = caught.length >= 2 && caught[0].body.includes('Hookkeep alert');
  console.log('alerts.ndjson +', proAlertLines, 'lines; webhook caught:', caught.length);

  // 3) free tier never alerts
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
  const freeOk = !freeIngest.alert && alertLines() === freeBefore;
  console.log('free-tier ingest alert:', freeIngest.alert ?? null, '(expect null)');

  const wait = await fetch(`${BASE}/api/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'wait@example.com', note: 'smoke' }),
  }).then((r) => r.json());
  console.log('waitlist', wait);

  catcher.close();

  if (
    !ingest.ok ||
    events.events.length < 1 ||
    unlock.workspace?.tier !== 'paid' ||
    !kwOk ||
    !stOk ||
    proAlertLines < 2 ||
    !hookOk ||
    !freeOk
  ) {
    process.exitCode = 1;
    console.error('SMOKE FAILED');
  } else {
    console.log('SMOKE OK');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
