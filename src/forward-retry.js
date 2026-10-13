/**
 * Hookkeep — auto-forward retries with backoff (shared by Node server + Workers).
 *
 * Per inbox:
 *   forwardRetries    0–5 (default 0 = single attempt, the pre-2026-10-13 behaviour)
 *   forwardBackoffMs  base delay 100–60000 ms (default 1000); gap before retry n = base · 2^(n-1),
 *                     each gap capped at 5 min → default schedule 1s, 2s, 4s, 8s, 16s
 *
 * Only transient failures are retried: network error / timeout, HTTP 408, 425, 429 and 5xx.
 * Any other 4xx, a bad URL or a non-http(s) protocol fails immediately (`gaveUp: non_retryable`).
 *
 * event.autoForward keeps the legacy top-level fields of the LAST attempt
 * ({ ok, status, ms, target, error?, message? }) plus:
 *   state         delivered | pending | failed
 *   attempts[]    { n, at, ok, status?, ms?, error?, retryable, manual? } (newest 12 kept)
 *   attemptCount  total attempts incl. manual retries; autoAttempts = automatic ones only
 *   maxAttempts   forwardRetries + 1 (frozen at ingest time)
 *   backoffMs     base delay (frozen at ingest time)
 *   nextAttemptAt ISO time of the next automatic retry (pending only)
 *   gaveUp        non_retryable | exhausted | budget (failed only)
 *
 * Pure ESM, zero deps.
 */

export const FORWARD_RETRIES_MAX = 5;
export const FORWARD_BACKOFF_DEFAULT_MS = 1000;
export const FORWARD_BACKOFF_MIN_MS = 100;
export const FORWARD_BACKOFF_MAX_MS = 60_000;
export const FORWARD_GAP_CAP_MS = 300_000;
export const FORWARD_ATTEMPTS_KEEP = 12;
export const FORWARD_STATES = ['delivered', 'pending', 'failed'];
export const FORWARD_FILTERS = ['delivered', 'pending', 'failed', 'none'];
/** Workers: retries run inside ctx.waitUntil, which Cloudflare cuts ~30s after the response. */
export const WORKERS_RETRY_BUDGET_MS = 25_000;

function intOrNull(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

/**
 * Validate a PATCH body's retry fields.
 * Returns { ok: true, patch } (only keys present) or { ok: false, error, message } — nothing applied.
 */
export function normalizeForwardRetryPatch(body = {}) {
  const patch = {};
  if (!body || typeof body !== 'object') return { ok: true, patch };
  if (body.forwardRetries !== undefined) {
    const n = body.forwardRetries === null || body.forwardRetries === '' ? 0 : intOrNull(body.forwardRetries);
    if (n == null || n < 0 || n > FORWARD_RETRIES_MAX) {
      return {
        ok: false,
        error: 'bad_forward_retries',
        message: `forwardRetries must be an integer 0–${FORWARD_RETRIES_MAX}`,
      };
    }
    patch.forwardRetries = n;
  }
  if (body.forwardBackoffMs !== undefined) {
    const raw = body.forwardBackoffMs;
    const n = raw === null || raw === '' || raw === 0 || raw === '0' ? FORWARD_BACKOFF_DEFAULT_MS : intOrNull(raw);
    if (n == null || n < FORWARD_BACKOFF_MIN_MS || n > FORWARD_BACKOFF_MAX_MS) {
      return {
        ok: false,
        error: 'bad_forward_backoff',
        message: `forwardBackoffMs must be an integer ${FORWARD_BACKOFF_MIN_MS}–${FORWARD_BACKOFF_MAX_MS} (0 = default ${FORWARD_BACKOFF_DEFAULT_MS})`,
      };
    }
    patch.forwardBackoffMs = n;
  }
  return { ok: true, patch };
}

/** Clamp stored inbox values (legacy inboxes have neither field). */
export function forwardRetryConfig(inbox = {}) {
  const r = intOrNull(inbox.forwardRetries);
  const b = intOrNull(inbox.forwardBackoffMs);
  return {
    retries: r == null ? 0 : Math.min(Math.max(r, 0), FORWARD_RETRIES_MAX),
    backoffMs:
      b == null || b < FORWARD_BACKOFF_MIN_MS || b > FORWARD_BACKOFF_MAX_MS ? FORWARD_BACKOFF_DEFAULT_MS : b,
  };
}

/** Gap (ms) before each retry: base · 2^(n-1), each capped at FORWARD_GAP_CAP_MS. */
export function backoffSchedule(retries, baseMs = FORWARD_BACKOFF_DEFAULT_MS) {
  const out = [];
  for (let i = 0; i < retries; i++) out.push(Math.min(baseMs * 2 ** i, FORWARD_GAP_CAP_MS));
  return out;
}

/** Public view of an inbox's retry config (PATCH/GET responses). */
export function publicForwardRetryConfig(inbox = {}) {
  const { retries, backoffMs } = forwardRetryConfig(inbox);
  return { forwardRetries: retries, forwardBackoffMs: backoffMs, forwardSchedule: backoffSchedule(retries, backoffMs) };
}

/** Transient? network error / timeout, 408, 425, 429, 5xx. */
export function isRetryableResult(result) {
  if (!result) return false;
  if (result.ok) return false;
  if (result.status != null) {
    const s = Number(result.status);
    return s === 408 || s === 425 || s === 429 || s >= 500;
  }
  return result.error === 'forward_failed';
}

/** Fresh pending record created when an ingest triggers auto-forward. */
export function startForwardRecord({ target, retries = 0, backoffMs = FORWARD_BACKOFF_DEFAULT_MS } = {}) {
  return {
    state: 'pending',
    target: String(target || '').slice(0, 500),
    maxAttempts: Math.min(Math.max(Number(retries) || 0, 0), FORWARD_RETRIES_MAX) + 1,
    backoffMs,
    attemptCount: 0,
    autoAttempts: 0,
    attempts: [],
  };
}

/**
 * Fold one attempt result into the record (returns a new object).
 * @returns {{ record: object, nextDelayMs: number|null }} nextDelayMs set when another automatic retry is due.
 */
export function applyForwardAttempt(prev, result, { now = Date.now(), manual = false } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const record = {
    ...base,
    attempts: Array.isArray(base.attempts) ? base.attempts.slice() : [],
  };
  // Legacy single-attempt records (pre-retry): count what they represent
  if (record.attemptCount == null) record.attemptCount = base.ok != null ? 1 : 0;
  if (record.autoAttempts == null) record.autoAttempts = base.ok != null ? 1 : 0;
  if (record.maxAttempts == null) record.maxAttempts = 1;
  if (record.backoffMs == null) record.backoffMs = FORWARD_BACKOFF_DEFAULT_MS;

  const r = result || { ok: false, error: 'forward_failed' };
  const retryable = isRetryableResult(r);
  record.attemptCount += 1;
  if (!manual) record.autoAttempts += 1;
  const attempt = { n: record.attemptCount, at: new Date(now).toISOString(), ok: Boolean(r.ok), retryable };
  if (r.status != null) attempt.status = r.status;
  if (r.ms != null) attempt.ms = r.ms;
  if (!r.ok && r.error) attempt.error = String(r.error).slice(0, 80);
  if (manual) attempt.manual = true;
  record.attempts.push(attempt);
  if (record.attempts.length > FORWARD_ATTEMPTS_KEEP) record.attempts = record.attempts.slice(-FORWARD_ATTEMPTS_KEEP);

  // Legacy top-level fields = last attempt (dashboard / export / CSV autoForwardOk keep working)
  record.ok = Boolean(r.ok);
  if (r.status != null) record.status = r.status;
  else delete record.status;
  if (r.ms != null) record.ms = r.ms;
  else delete record.ms;
  if (r.target) record.target = String(r.target).slice(0, 500);
  if (!r.ok && r.error) record.error = String(r.error).slice(0, 80);
  else delete record.error;
  if (!r.ok && r.message) record.message = String(r.message).slice(0, 200);
  else delete record.message;
  delete record.nextAttemptAt;

  if (r.ok) {
    record.state = 'delivered';
    delete record.gaveUp;
    return { record, nextDelayMs: null };
  }
  if (!manual && retryable && record.autoAttempts < record.maxAttempts) {
    const schedule = backoffSchedule(record.maxAttempts - 1, record.backoffMs);
    const delay = schedule[record.autoAttempts - 1] ?? schedule[schedule.length - 1] ?? 0;
    record.state = 'pending';
    record.nextAttemptAt = new Date(now + delay).toISOString();
    delete record.gaveUp;
    return { record, nextDelayMs: delay };
  }
  record.state = 'failed';
  if (manual) record.gaveUp = record.gaveUp || (retryable ? 'exhausted' : 'non_retryable');
  else record.gaveUp = retryable ? 'exhausted' : 'non_retryable';
  return { record, nextDelayMs: null };
}

/** Mark a pending record failed because the runtime can't wait any longer (Workers waitUntil budget). */
export function giveUpForBudget(record) {
  const out = { ...record, state: 'failed', gaveUp: 'budget' };
  delete out.nextAttemptAt;
  return out;
}

/**
 * Attempt + in-process retries under a wall-clock budget (Workers waitUntil; also unit-testable).
 * attempt(timeoutMs, n) must resolve to a forward result and never throw.
 */
export async function deliverWithRetries({
  record,
  attempt,
  budgetMs = WORKERS_RETRY_BUDGET_MS,
  perAttemptTimeoutMs = 8000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
}) {
  const started = clock();
  let rec = record;
  for (;;) {
    const remaining = budgetMs - (clock() - started);
    const timeout = Math.max(1000, Math.min(perAttemptTimeoutMs, remaining));
    const res = await attempt(timeout, (rec.attemptCount || 0) + 1);
    const step = applyForwardAttempt(rec, res, { now: clock() });
    rec = step.record;
    if (step.nextDelayMs == null) return rec;
    if (clock() - started + step.nextDelayMs + 1000 > budgetMs) return giveUpForBudget(rec);
    await sleep(step.nextDelayMs);
  }
}

/** delivered | pending | failed | null (no auto-forward). Legacy records derive from ok. */
export function forwardStateOf(e) {
  const af = e && e.autoForward;
  if (!af || typeof af !== 'object') return null;
  if (FORWARD_STATES.includes(af.state)) return af.state;
  return af.ok ? 'delivered' : 'failed';
}

/** ?forward= filter: delivered | pending | failed | none (anything else = no filter). */
export function forwardFilterMatch(e, f) {
  const want = String(f || '').toLowerCase();
  if (!FORWARD_FILTERS.includes(want)) return true;
  const s = forwardStateOf(e);
  return want === 'none' ? s == null : s === want;
}

/** Compact list-row fields. */
export function publicForwardFields(e) {
  const s = forwardStateOf(e);
  if (!s) return { forwardState: null, forwardAttempts: 0 };
  const af = e.autoForward;
  return { forwardState: s, forwardAttempts: af.attemptCount != null ? af.attemptCount : 1 };
}
