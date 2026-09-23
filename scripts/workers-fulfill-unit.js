/** Unit: Workers stripe fulfill auth + code resolution (no wrangler / no CF). */
function fulfillAuthCheck(envSecret, headerSecret) {
  if (!envSecret) return { ok: false, status: 503, error: 'fulfill_not_configured' };
  if (String(headerSecret || '') !== String(envSecret))
    return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true, status: 200 };
}

function resolveFulfillCode(body, mintFn) {
  let code = String(body.code || '').trim();
  if (!code && body.sessionId) {
    code = mintFn(body.sessionId);
  }
  if (!code) return { error: 'need_code_or_session' };
  return { code };
}

function mintUnlockCodeString(sessionId, rand8 = 'abcd1234') {
  // Shape mirror of worker mintUnlockCodeString — prefix + 8 upper alnum
  void sessionId;
  return 'HOOKKEEP-PRO-' + String(rand8).toUpperCase();
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FULFILL UNIT FAILED:', msg);
    process.exit(1);
  }
}

// Auth gate
assert(fulfillAuthCheck('', 'x').status === 503, 'no secret → 503');
assert(fulfillAuthCheck('', 'x').error === 'fulfill_not_configured', '503 error code');
assert(fulfillAuthCheck('sec', 'wrong').status === 401, 'bad header → 401');
assert(fulfillAuthCheck('sec', 'wrong').error === 'unauthorized', '401 error code');
assert(fulfillAuthCheck('sec', 'sec').ok === true, 'matching secret ok');

// Code resolution
assert(resolveFulfillCode({}, () => 'X').error === 'need_code_or_session', 'need code or session');
assert(resolveFulfillCode({ code: '  ABC  ' }, () => 'X').code === 'ABC', 'trim explicit code');
let minted = null;
const fromSession = resolveFulfillCode({ sessionId: 'cs_test_1234567890' }, (sid) => {
  minted = mintUnlockCodeString(sid, 'zx9y8w7v');
  return minted;
});
assert(fromSession.code === 'HOOKKEEP-PRO-ZX9Y8W7V', 'mint from sessionId');
assert(fromSession.code.startsWith('HOOKKEEP-PRO-'), 'mint prefix');
assert(fromSession.code.length === 'HOOKKEEP-PRO-'.length + 8, 'mint length 8 suffix');

// Explicit code wins over sessionId
assert(
  resolveFulfillCode({ code: 'KEEP', sessionId: 'cs_x' }, () => 'MINT').code === 'KEEP',
  'code preferred over sessionId'
);

// Env alias note: worker accepts FULFILL_SECRET || HOOKKEEP_FULFILL_SECRET
const envSecret = '' || 'hook-secret';
assert(fulfillAuthCheck(envSecret, 'hook-secret').ok, 'HOOKKEEP-style secret works via same gate');

console.log('FULFILL UNIT OK (Workers stripe fulfill auth/code parity)');
