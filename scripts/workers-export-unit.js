/** Unit: Workers/Node CSV escape + export row shaping (no wrangler). */
function escapeCsvField(val) {
  const s = val == null ? '' : String(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const BODY_EXPORT_MAX = 8192;

function toExportEvent(e) {
  const body = String(e.bodyText || '');
  const truncated = body.length > BODY_EXPORT_MAX;
  const out = {
    id: e.id,
    receivedAt: e.receivedAt,
    method: e.method,
    status: e.statusGuess != null ? e.statusGuess : null,
    contentType: e.contentType || '',
    bodyText: truncated ? body.slice(0, BODY_EXPORT_MAX) : body,
    bodyTruncated: truncated || undefined,
    size: e.size,
  };
  if (e.autoForward && typeof e.autoForward === 'object') {
    out.autoForward = {
      ok: Boolean(e.autoForward.ok),
      status: e.autoForward.status ?? null,
      ms: e.autoForward.ms ?? null,
      error: e.autoForward.error || null,
      target: e.autoForward.target || null,
    };
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('EXPORT UNIT FAILED:', msg);
    process.exit(1);
  }
}

assert(escapeCsvField('plain') === 'plain', 'plain field');
assert(escapeCsvField('a,b') === '"a,b"', 'comma field');
assert(escapeCsvField('say "hi"') === '"say ""hi"""', 'quote field');
assert(escapeCsvField('line1\nline2') === '"line1\nline2"', 'newline field');

const big = 'x'.repeat(BODY_EXPORT_MAX + 50);
const row = toExportEvent({
  id: 'ev_1',
  receivedAt: '2026-09-25T12:00:00.000Z',
  method: 'POST',
  statusGuess: '200',
  contentType: 'application/json',
  bodyText: big,
  size: big.length,
  autoForward: { ok: true, status: 200, ms: 12, target: 'https://example.com/hook' },
});
assert(row.bodyText.length === BODY_EXPORT_MAX, 'body truncate length');
assert(row.bodyTruncated === true, 'bodyTruncated flag');
assert(row.status === '200', 'status maps statusGuess');
assert(row.autoForward?.ok === true && row.autoForward?.target, 'autoForward summary');

console.log('EXPORT UNIT OK (CSV escape + export row shape)');
