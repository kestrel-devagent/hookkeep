/** Local smoke test against a running server (default http://127.0.0.1:8787) */
const BASE = process.env.HOOKKEEP_URL || 'http://127.0.0.1:8787';

async function main() {
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

  const wait = await fetch(`${BASE}/api/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'wait@example.com', note: 'smoke' }),
  }).then((r) => r.json());
  console.log('waitlist', wait);

  if (!ingest.ok || events.events.length < 1 || unlock.workspace?.tier !== 'paid') {
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
