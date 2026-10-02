/** Unit: bulk replay response shaping + hard-max clamp (no server). */
function clampBulkLimit(limit) {
  const HARD_MAX = 50;
  return Math.min(Number(limit) || 50, HARD_MAX);
}

function compactReplayResult(rowId, r) {
  const compact = { id: rowId, ok: Boolean(r && r.ok) };
  if (r && r.status != null) compact.status = r.status;
  if (r && r.ms != null) compact.ms = r.ms;
  if (r && !r.ok) compact.error = r.error || r.message || 'forward_failed';
  return compact;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('REPLAY-BULK UNIT FAILED:', msg);
    process.exit(1);
  }
}

assert(clampBulkLimit(undefined) === 50, 'default 50');
assert(clampBulkLimit(10) === 10, 'respect lower');
assert(clampBulkLimit(999) === 50, 'hard max 50');
assert(clampBulkLimit(0) === 50, '0 → default 50');
assert(clampBulkLimit('12') === 12, 'string number');

const ok = compactReplayResult('ev_1', { ok: true, status: 200, ms: 11, target: 'https://x' });
assert(ok.id === 'ev_1' && ok.ok === true && ok.status === 200 && ok.ms === 11, 'ok compact');
assert(ok.error === undefined, 'ok should omit error');

const bad = compactReplayResult('ev_2', { ok: false, error: 'forward_failed', message: 'boom', ms: 3 });
assert(bad.ok === false && bad.error === 'forward_failed' && bad.ms === 3, 'fail compact');

console.log('REPLAY-BULK UNIT OK (limit clamp + compact result)');
