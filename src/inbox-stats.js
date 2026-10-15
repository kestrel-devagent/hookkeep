/**
 * Per-inbox stats — shared by the Node server (src/db.js) and Workers (workers/src/worker.js).
 * Pure ESM, zero deps.
 *
 * GET /api/inboxes/:id/stats?window=1h|24h|7d|all (default 24h)
 * Counts events whose receivedAt falls inside the window. Free tier OK.
 */

import { forwardStateOf } from './forward-retry.js';

export const STATS_WINDOWS = ['1h', '24h', '7d', 'all'];
export const DEFAULT_STATS_WINDOW = '24h';

const WINDOW_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** Parse ?window= — empty/missing → 24h. Unknown → { ok:false, error:'bad_window' }. */
export function parseStatsWindow(raw) {
  const w = raw == null || raw === '' ? DEFAULT_STATS_WINDOW : String(raw).trim().toLowerCase();
  if (!STATS_WINDOWS.includes(w)) {
    return { ok: false, error: 'bad_window', message: 'window must be 1h, 24h, 7d, or all' };
  }
  return { ok: true, window: w };
}

/** ISO start of the window, or null when window=all. */
export function windowStartedAt(window, now = Date.now()) {
  if (window === 'all') return null;
  const ms = WINDOW_MS[window];
  if (ms == null) return null;
  return new Date(now - ms).toISOString();
}

/** True when event.receivedAt is inside the window (inclusive of start). Missing/invalid receivedAt → excluded unless window=all. */
export function eventInWindow(event, window, now = Date.now()) {
  if (window === 'all') return true;
  const ms = WINDOW_MS[window];
  if (ms == null) return false;
  const t = Date.parse(event && event.receivedAt);
  if (Number.isNaN(t)) return false;
  return t >= now - ms;
}

/** statusGuess → 2xx | 3xx | 4xx | 5xx | other */
export function statusBucket(statusGuess) {
  const n = Number(String(statusGuess ?? '').trim());
  if (!Number.isFinite(n) || n < 100 || n > 599) return 'other';
  if (n < 300) return '2xx';
  if (n < 400) return '3xx';
  if (n < 500) return '4xx';
  return '5xx';
}

/** signature.valid true → valid, false → invalid, else unchecked */
export function signatureBucket(event) {
  const s = event && event.signature;
  if (s && typeof s === 'object' && s.valid === true) return 'valid';
  if (s && typeof s === 'object' && s.valid === false) return 'invalid';
  return 'unchecked';
}

/** forwardStateOf → delivered | pending | failed | none */
export function forwardBucket(event) {
  const s = forwardStateOf(event);
  if (s === 'delivered' || s === 'pending' || s === 'failed') return s;
  return 'none';
}

/**
 * Aggregate raw events into the stats response shape.
 * Caller owns auth / inbox ownership; this is pure counting.
 * Returns { ok:true, … } or { ok:false, error:'bad_window', … }.
 */
export function computeInboxStats(events, { inboxId, window = DEFAULT_STATS_WINDOW, now = Date.now() } = {}) {
  const parsed = parseStatsWindow(window);
  if (!parsed.ok) return parsed;
  const w = parsed.window;
  const filtered = (Array.isArray(events) ? events : []).filter((e) => eventInWindow(e, w, now));

  const byMethod = {};
  const byStatusBucket = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const byForwardState = { delivered: 0, pending: 0, failed: 0, none: 0 };
  const bySignature = { valid: 0, invalid: 0, unchecked: 0 };
  let pinned = 0;
  let oldestReceivedAt = null;
  let newestReceivedAt = null;

  for (const e of filtered) {
    const method = String((e && e.method) || 'UNKNOWN').toUpperCase() || 'UNKNOWN';
    byMethod[method] = (byMethod[method] || 0) + 1;
    byStatusBucket[statusBucket(e && e.statusGuess)] += 1;
    byForwardState[forwardBucket(e)] += 1;
    bySignature[signatureBucket(e)] += 1;
    if (e && e.pinned) pinned += 1;
    const ra = e && e.receivedAt ? String(e.receivedAt) : null;
    if (ra) {
      if (!oldestReceivedAt || ra < oldestReceivedAt) oldestReceivedAt = ra;
      if (!newestReceivedAt || ra > newestReceivedAt) newestReceivedAt = ra;
    }
  }

  return {
    ok: true,
    inboxId: inboxId != null ? String(inboxId) : null,
    window: w,
    windowStartedAt: windowStartedAt(w, now),
    generatedAt: new Date(now).toISOString(),
    total: filtered.length,
    pinned,
    byMethod,
    byStatusBucket,
    byForwardState,
    bySignature,
    oldestReceivedAt,
    newestReceivedAt,
  };
}
