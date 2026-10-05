/** Unit: bulk delete confirm gate + hard-max clamp + eventCount floor + KV delete (no server). */
function clampBulkLimit(limit) {
  const HARD_MAX = 50;
  return Math.min(Number(limit) || 50, HARD_MAX);
}

function confirmGate(body) {
  if (!body || body.confirm !== true) {
    return { error: 'confirm_required', message: 'Set body.confirm=true to delete the filtered events (irreversible)' };
  }
  return null;
}

function decrementCount(eventCount, deleted) {
  return Math.max(0, (eventCount || 0) - deleted);
}

/** Minimal KV mock mirroring the Workers delete-bulk flow. */
function makeKv(entries) {
  const m = new Map(entries);
  return {
    m,
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) };
    },
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async delete(k) { m.delete(k); },
  };
}

async function deleteBulk(kv, inbox, body) {
  const gate = confirmGate(body);
  if (gate) return gate;
  const cap = clampBulkLimit(body.limit);
  const q = String(body.q || '').toLowerCase();
  const listed = await kv.list({ prefix: `evt:${inbox.id}:` });
  const keys = [];
  const ids = [];
  for (const k of listed.keys) {
    if (ids.length >= cap) break;
    const ev = await kv.get(k.name);
    if (!ev) continue;
    if (q && !(ev.bodyText || '').toLowerCase().includes(q)) continue;
    keys.push(k.name);
    ids.push(ev.id);
  }
  await Promise.all(keys.map((k) => kv.delete(k)));
  inbox.eventCount = decrementCount(inbox.eventCount, ids.length);
  return { ok: true, inboxId: inbox.id, filters: { q: q || undefined, limit: cap }, deleted: ids.length, ids };
}

function assert(cond, msg) {
  if (!cond) {
    console.error('DELETE-BULK UNIT FAILED:', msg);
    process.exit(1);
  }
}

assert(clampBulkLimit(undefined) === 50, 'default 50');
assert(clampBulkLimit(5) === 5, 'respect lower');
assert(clampBulkLimit(999) === 50, 'hard max 50');

assert(confirmGate({})?.error === 'confirm_required', 'missing confirm');
assert(confirmGate({ confirm: 'true' })?.error === 'confirm_required', 'string confirm rejected');
assert(confirmGate({ confirm: 1 })?.error === 'confirm_required', 'numeric confirm rejected');
assert(confirmGate({ confirm: true }) === null, 'confirm true passes');

assert(decrementCount(5, 3) === 2, 'decrement');
assert(decrementCount(2, 5) === 0, 'floor at 0');
assert(decrementCount(undefined, 1) === 0, 'undefined count floor');

const kv = makeKv([
  ['evt:inb_a:001_e1', JSON.stringify({ id: 'e1', bodyText: '{"event":"cleanup"}' })],
  ['evt:inb_a:002_e2', JSON.stringify({ id: 'e2', bodyText: '{"event":"keep"}' })],
  ['evt:inb_a:003_e3', JSON.stringify({ id: 'e3', bodyText: '{"event":"cleanup"}' })],
  ['evt:inb_b:001_x1', JSON.stringify({ id: 'x1', bodyText: '{"event":"cleanup"}' })],
]);
const inbox = { id: 'inb_a', eventCount: 3 };

const noConfirm = await deleteBulk(kv, inbox, { q: 'cleanup' });
assert(noConfirm.error === 'confirm_required' && kv.m.size === 4 && inbox.eventCount === 3, 'no-confirm must not delete');

const res = await deleteBulk(kv, inbox, { q: 'cleanup', confirm: true });
assert(res.ok === true && res.deleted === 2, 'deleted 2');
assert(res.ids.includes('e1') && res.ids.includes('e3') && !res.ids.includes('e2'), 'ids');
assert(!kv.m.has('evt:inb_a:001_e1') && kv.m.has('evt:inb_a:002_e2'), 'kv keys');
assert(kv.m.has('evt:inb_b:001_x1'), 'other inbox untouched');
assert(inbox.eventCount === 1, 'eventCount decremented');

console.log('DELETE-BULK UNIT OK (confirm gate + limit clamp + count floor + KV delete)');
