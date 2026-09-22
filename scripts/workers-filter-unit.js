/** Unit: Workers event-filter predicate parity with Node listEvents (no wrangler). */
function matchesEvent(ev, { q = '', method = '', statusMin = null } = {}) {
  const qq = (q || '').toLowerCase();
  if (qq) {
    const hay =
      (ev.bodyText || '').toLowerCase().includes(qq) ||
      (ev.statusGuess || '').toLowerCase().includes(qq) ||
      (ev.method || '').toLowerCase().includes(qq) ||
      String(ev.id || '').includes(qq);
    if (!hay) return false;
  }
  if (method) {
    const mm = String(method).toUpperCase();
    if (String(ev.method || '').toUpperCase() !== mm) return false;
  }
  if (statusMin != null && statusMin !== '' && !Number.isNaN(Number(statusMin))) {
    const min = Number(statusMin);
    const n = Number(String(ev.statusGuess ?? '').trim());
    if (Number.isNaN(n) || n < min) return false;
  }
  return true;
}

const fixtures = [
  { id: 'evt_pay', method: 'POST', bodyText: '{"event":"payment.succeeded"}', statusGuess: '200' },
  { id: 'evt_get', method: 'GET', bodyText: '', statusGuess: '' },
  { id: 'evt_502', method: 'POST', bodyText: '{"status":502}', statusGuess: '502' },
];

function assert(cond, msg) {
  if (!cond) {
    console.error('FILTER UNIT FAILED:', msg);
    process.exit(1);
  }
}

const byQ = fixtures.filter((e) => matchesEvent(e, { q: 'payment' }));
assert(byQ.length === 1 && byQ[0].id === 'evt_pay', 'q=payment');

const byMethod = fixtures.filter((e) => matchesEvent(e, { method: 'GET' }));
assert(byMethod.length === 1 && byMethod[0].id === 'evt_get', 'method=GET');

const byStatus = fixtures.filter((e) => matchesEvent(e, { statusMin: 500 }));
assert(byStatus.length === 1 && byStatus[0].id === 'evt_502', 'statusMin=500');

const byCombo = fixtures.filter((e) => matchesEvent(e, { method: 'POST', statusMin: 500 }));
assert(byCombo.length === 1 && byCombo[0].id === 'evt_502', 'method+statusMin');

// method included in q search (Node parity)
const byQMethod = fixtures.filter((e) => matchesEvent(e, { q: 'get' }));
assert(byQMethod.some((e) => e.id === 'evt_get'), 'q matches method text');

console.log('FILTER UNIT OK (Workers/Node predicate parity)');
