/** Local smoke test against a running server (default http://127.0.0.1:8787)
 * Steps: create → ingest → list → export → forwardUrl → replay → replay-bulk → delete-bulk → auto-forward → demo unlock → pro alerts → free tier → custom response
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

  step('export filtered events JSON');
  const expJsonRes = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events/export?format=json&q=${encodeURIComponent('payment')}`,
    { headers: { 'x-hookkeep-token': created.ownerToken } }
  );
  check(expJsonRes.ok, `export json status ${expJsonRes.status}`);
  check((expJsonRes.headers.get('content-type') || '').includes('application/json'), 'export json content-type');
  const expJson = await expJsonRes.json();
  check(Array.isArray(expJson.events), 'export json missing events array');
  check(expJson.inboxId === created.inbox.id, 'export json inboxId mismatch');
  check(expJson.events.some((e) => e.id === ingest.id), 'export json missed payment event');
  check(expJson.events.every((e) => e.id && e.receivedAt && e.method), 'export json row shape');
  console.log('export json', expJson.events.length, 'events');

  step('export filtered events CSV');
  const expCsvRes = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events/export?format=csv`,
    { headers: { 'x-hookkeep-token': created.ownerToken } }
  );
  check(expCsvRes.ok, `export csv status ${expCsvRes.status}`);
  check((expCsvRes.headers.get('content-type') || '').includes('text/csv'), 'export csv content-type');
  const expCsv = await expCsvRes.text();
  const csvLines = expCsv.trim().split(/\r?\n/);
  check(csvLines[0] === 'id,receivedAt,method,status,contentType,bodyPreview,autoForwardOk', 'csv header mismatch');
  check(csvLines.length >= 3, `csv expected header+rows, got ${csvLines.length}`);
  check(expCsv.includes(ingest.id), 'csv missing payment event id');
  check(expCsv.includes(ingestGet.id), 'csv missing GET event id');
  console.log('export csv lines', csvLines.length);

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

  step('bulk replay-filtered without target → no_forward_url');
  await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ forwardUrl: '' }),
  }).then((r) => r.json());
  const bulkNoT = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/replay-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ q: 'payment' }),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  check(bulkNoT.status === 400 && bulkNoT.error === 'no_forward_url', `bulk no target: ${JSON.stringify(bulkNoT)}`);

  step('bulk replay filtered q=payment');
  await fetch(`${BASE}/api/inboxes/${created.inbox.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ forwardUrl: replayUrl }),
  }).then((r) => r.json());
  const bulkCaughtBefore = caught.length;
  const bulk = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/replay-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ q: 'payment', limit: 50 }),
  }).then((r) => r.json());
  console.log('bulk replay', bulk.attempted, bulk.succeeded, bulk.failed, bulk.target);
  check(bulk.ok === true, `bulk not ok: ${JSON.stringify(bulk)}`);
  check(bulk.inboxId === created.inbox.id, 'bulk inboxId mismatch');
  check(bulk.attempted >= 1 && bulk.succeeded === bulk.attempted, 'bulk attempted/succeeded mismatch');
  check(Array.isArray(bulk.results) && bulk.results.every((r) => r.id && r.ok === true), 'bulk results shape');
  check(bulk.results.some((r) => r.id === ingest.id), 'bulk missed payment event');
  check(caught.length === bulkCaughtBefore + bulk.attempted, `catcher expected +${bulk.attempted}, got ${caught.length - bulkCaughtBefore}`);
  check((bulk.filters && bulk.filters.q === 'payment'), 'bulk filters.q missing');

  step('bulk replay hard max 50');
  const bulkCap = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/replay-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ limit: 999, method: 'POST' }),
  }).then((r) => r.json());
  check(bulkCap.filters?.limit === 50, `hard max expected 50, got ${bulkCap.filters?.limit}`);
  check(bulkCap.attempted <= 50, `attempted over hard max: ${bulkCap.attempted}`);

  step('bulk delete-filtered: ingest 3 cleanup events');
  const cleanupIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cleanup.marker', n: i }),
    }).then((r) => r.json());
    check(r.ok && r.id, `cleanup ingest ${i} failed`);
    cleanupIds.push(r.id);
  }
  const wsBeforeDel = await fetch(`${BASE}/api/workspace`, { headers: auth }).then((r) => r.json());
  const countBeforeDel = (wsBeforeDel.inboxes.find((i) => i.id === created.inbox.id) || {}).eventCount;
  const delFiltered = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events?q=${encodeURIComponent('cleanup.marker')}`,
    { headers: auth }
  ).then((r) => r.json());
  check(delFiltered.events.length === 3, `cleanup filter expected 3, got ${delFiltered.events.length}`);

  step('bulk delete-filtered unauthorized → 401');
  const delUnauth = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/delete-bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'cleanup.marker', confirm: true }),
  });
  check(delUnauth.status === 401, `delete-bulk unauth expected 401, got ${delUnauth.status}`);

  step('bulk delete-filtered unknown inbox → 404');
  const del404 = await fetch(`${BASE}/api/inboxes/inb_nope/events/delete-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ q: 'cleanup.marker', confirm: true }),
  });
  check(del404.status === 404, `delete-bulk unknown inbox expected 404, got ${del404.status}`);

  step('bulk delete-filtered without confirm → 400 confirm_required');
  const delNoConfirm = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/delete-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ q: 'cleanup.marker' }),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  check(
    delNoConfirm.status === 400 && delNoConfirm.error === 'confirm_required',
    `delete no confirm: ${JSON.stringify(delNoConfirm)}`
  );
  const stillThere = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events?q=${encodeURIComponent('cleanup.marker')}`,
    { headers: auth }
  ).then((r) => r.json());
  check(stillThere.events.length === 3, 'events deleted without confirm');

  step('bulk delete-filtered with confirm → deleted');
  const del = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events/delete-bulk`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ q: 'cleanup.marker', confirm: true }),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  console.log('bulk delete', del.status, del.deleted, del.ids);
  check(del.status === 200 && del.ok === true, `delete-bulk not ok: ${JSON.stringify(del)}`);
  check(del.inboxId === created.inbox.id, 'delete inboxId mismatch');
  check(del.deleted === 3, `expected 3 deleted, got ${del.deleted}`);
  check(Array.isArray(del.ids) && cleanupIds.every((id) => del.ids.includes(id)), 'delete ids mismatch');
  check(del.filters && del.filters.q === 'cleanup.marker' && del.filters.limit === 50, 'delete filters shape');

  step('list no longer shows deleted events; others intact; eventCount decremented');
  const afterDel = await fetch(
    `${BASE}/api/inboxes/${created.inbox.id}/events?q=${encodeURIComponent('cleanup.marker')}`,
    { headers: auth }
  ).then((r) => r.json());
  check(afterDel.events.length === 0, `deleted events still listed: ${afterDel.events.length}`);
  const allAfter = await fetch(`${BASE}/api/inboxes/${created.inbox.id}/events`, { headers: auth }).then((r) => r.json());
  check(allAfter.events.some((e) => e.id === ingest.id), 'delete-bulk removed unrelated payment event');
  const delGone = await fetch(`${BASE}/api/events/${cleanupIds[0]}`, { headers: auth });
  check(delGone.status === 404, `deleted event detail expected 404, got ${delGone.status}`);
  const wsAfterDel = await fetch(`${BASE}/api/workspace`, { headers: auth }).then((r) => r.json());
  const countAfterDel = (wsAfterDel.inboxes.find((i) => i.id === created.inbox.id) || {}).eventCount;
  if (typeof countBeforeDel === 'number') {
    check(countAfterDel === Math.max(0, countBeforeDel - 3), `eventCount ${countBeforeDel} → ${countAfterDel}`);
  }

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

  step('custom ingest response (status/body/content-type)');
  const crHdr = { 'x-hookkeep-token': free.ownerToken, 'content-type': 'application/json' };
  const crPatch = (body) =>
    fetch(`${BASE}/api/inboxes/${free.inbox.id}`, { method: 'PATCH', headers: crHdr, body: JSON.stringify(body) });
  const badCr = await crPatch({ responseStatus: 999, name: 'should-not-apply' });
  const badCrBody = await badCr.json();
  check(badCr.status === 400 && badCrBody.error === 'bad_response_status', `bad status not rejected (${badCr.status})`);
  const crUnauth = await fetch(`${BASE}/api/inboxes/${free.inbox.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ responseStatus: 503 }),
  });
  check(crUnauth.status === 401, `custom response PATCH unauth expected 401, got ${crUnauth.status}`);
  const crSet = await crPatch({
    responseStatus: 503,
    responseBody: '{"error":"simulated","id":"{{eventId}}","m":"{{method}}"}',
    responseContentType: '',
  }).then((r) => r.json());
  check(crSet.inbox?.responseStatus === 503 && crSet.inbox?.name !== 'should-not-apply', 'responseStatus not saved / bad patch half-applied');
  const cr503 = await fetch(`${BASE}/hook/${free.inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'retry.test' }),
  });
  const cr503Text = await cr503.text();
  const cr503Id = cr503.headers.get('x-hookkeep-event-id') || '';
  check(cr503.status === 503, `custom status expected 503, got ${cr503.status}`);
  check((cr503.headers.get('content-type') || '').includes('application/json'), 'auto content-type not json');
  check(cr503Id.startsWith('ev_') && cr503Text.includes(cr503Id) && cr503Text.includes('"m":"POST"'),
    `template not rendered: ${cr503Text}`);
  const crList = await fetch(`${BASE}/api/inboxes/${free.inbox.id}/events?q=retry.test`, { headers: crHdr }).then((r) => r.json());
  const crEv = crList.events.find((e) => e.id === cr503Id);
  check(crEv && crEv.respondedStatus === 503 && crEv.respondedCustom === true, 'event did not record respondedStatus 503');
  await crPatch({ responseStatus: 200, responseBody: '{{json.challenge}}', responseContentType: 'text/plain' });
  const crChal = await fetch(`${BASE}/hook/${free.inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'chal_abc123' }),
  });
  const crChalText = await crChal.text();
  check(crChal.status === 200 && crChalText === 'chal_abc123', `challenge echo failed: ${crChal.status} ${crChalText}`);
  check((crChal.headers.get('content-type') || '').startsWith('text/plain'), 'explicit content-type not honored');
  await crPatch({ responseStatus: 204 });
  const cr204 = await fetch(`${BASE}/hook/${free.inbox.id}`, { method: 'POST', body: 'x' });
  check(cr204.status === 204 && (await cr204.text()) === '', `204 expected empty body (got ${cr204.status})`);
  const crReset = await crPatch({ responseStatus: 0 }).then((r) => r.json());
  check(crReset.inbox?.responseStatus === 0, 'reset to default failed');
  const crDefault = await fetch(`${BASE}/hook/${free.inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"back":"default"}',
  });
  const crDefaultJson = await crDefault.json();
  check(crDefault.status === 200 && crDefaultJson.ok === true && crDefaultJson.received === true, 'default ack not restored');
  console.log('custom response: 400 bad / 401 unauth / 503 templated / challenge echo / 204 empty / default ack restored');

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
