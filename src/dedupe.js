/**
 * Hookkeep — per-inbox ingest deduplication (shared by Node server + Workers).
 *
 * Webhook providers retry. With an inbox `dedupeMode`, the same Idempotency-Key
 * (or the same raw body hash) reuses the prior capture instead of filling the
 * keep-window twice. On a hit: no new event, no eventCount bump, no alerts /
 * auto-forward re-fire. The ingest response matches a fresh capture for the
 * ORIGINAL eventId, plus headers `x-hookkeep-event-id` and `x-hookkeep-deduped: 1`.
 *
 * Modes:
 *   none          (default) — every delivery stored
 *   idempotency   trimmed value of `dedupeHeader` (default idempotency-key); missing → no dedupe
 *   body-hash     sha256:<hex> of raw body bytes (empty body has a stable hash); method NOT in key
 *   either        try idempotency header first; if absent, fall back to body-hash
 *
 * Pure ESM, zero deps — WebCrypto via globalThis.crypto.subtle (Node ≥ 18 + Workers).
 */

export const DEDUPE_MODES = ['none', 'idempotency', 'body-hash', 'either'];
export const DEDUPE_HEADER_DEFAULT = 'idempotency-key';
export const DEDUPE_HEADER_MAX = 64;
export const DEDUPE_KEY_VALUE_MAX = 256;
export const DEDUPE_MAP_MAX = 500;
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const enc = new TextEncoder();

/**
 * Validate a PATCH body's dedupe fields.
 * Returns { ok: true, patch } (only keys present in body) or { ok: false, error, message }.
 */
export function normalizeDedupePatch(body = {}) {
  const patch = {};
  if (body.dedupeMode !== undefined) {
    const m = normalizeDedupeMode(body.dedupeMode);
    if (m == null) {
      return {
        ok: false,
        error: 'bad_dedupe_mode',
        message: `dedupeMode must be one of ${DEDUPE_MODES.join(' | ')}`,
      };
    }
    patch.dedupeMode = m;
  }
  if (body.dedupeHeader !== undefined) {
    const h = normalizeDedupeHeader(body.dedupeHeader);
    if (h == null) {
      return {
        ok: false,
        error: 'bad_dedupe_header',
        message: `dedupeHeader must be a header name (letters, digits, - or _; ≤ ${DEDUPE_HEADER_MAX} chars)`,
      };
    }
    patch.dedupeHeader = h;
  }
  return { ok: true, patch };
}

/** Normalize mode → one of DEDUPE_MODES, or null if unknown. Empty/null → 'none'. */
export function normalizeDedupeMode(v) {
  if (v == null || v === '') return 'none';
  const m = String(v).trim().toLowerCase();
  return DEDUPE_MODES.includes(m) ? m : null;
}

/**
 * Normalize header name → lowercase string (empty → default).
 * Returns null if the non-empty value is invalid.
 */
export function normalizeDedupeHeader(v) {
  if (v == null || v === '') return DEDUPE_HEADER_DEFAULT;
  const h = String(v).trim().toLowerCase();
  if (!h) return DEDUPE_HEADER_DEFAULT;
  if (h.length > DEDUPE_HEADER_MAX || !HEADER_NAME_RE.test(h)) return null;
  return h;
}

/** Public view of the dedupe config for an inbox. */
export function publicDedupeConfig(inbox = {}) {
  const mode = DEDUPE_MODES.includes(inbox.dedupeMode) ? inbox.dedupeMode : 'none';
  const header =
    inbox.dedupeHeader && HEADER_NAME_RE.test(String(inbox.dedupeHeader).toLowerCase())
      ? String(inbox.dedupeHeader).toLowerCase()
      : DEDUPE_HEADER_DEFAULT;
  return { dedupeMode: mode, dedupeHeader: header };
}

/** Case-insensitive header lookup (plain object or Headers). */
export function headerValue(headers, name) {
  if (!headers || !name) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v.join(',') : String(v ?? '');
  }
  return '';
}

function toBytes(raw) {
  if (raw == null) return new Uint8Array(0);
  if (typeof raw === 'string') return enc.encode(raw);
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return enc.encode(String(raw));
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of body bytes → lowercase hex (WebCrypto). */
export async function bodyHashHex(bodyTextOrBytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('webcrypto_unavailable');
  return toHex(await subtle.digest('SHA-256', toBytes(bodyTextOrBytes)));
}

/**
 * Compute the dedupe key for an inbound delivery.
 * @returns {{ key: string|null, source: 'idempotency'|'body-hash'|null }}
 */
export async function computeDedupeKey({ mode, headerName, headers, bodyText } = {}) {
  const m = DEDUPE_MODES.includes(mode) ? mode : 'none';
  if (m === 'none') return { key: null, source: null };

  const tryIdem = async () => {
    const name = normalizeDedupeHeader(headerName) || DEDUPE_HEADER_DEFAULT;
    const raw = headerValue(headers, name).trim();
    if (!raw) return null;
    return raw.slice(0, DEDUPE_KEY_VALUE_MAX);
  };

  const tryHash = async () => {
    const hex = await bodyHashHex(bodyText == null ? '' : bodyText);
    return `sha256:${hex}`;
  };

  if (m === 'idempotency') {
    const key = await tryIdem();
    return key ? { key, source: 'idempotency' } : { key: null, source: null };
  }
  if (m === 'body-hash') {
    return { key: await tryHash(), source: 'body-hash' };
  }
  // either
  const fromHeader = await tryIdem();
  if (fromHeader) return { key: fromHeader, source: 'idempotency' };
  return { key: await tryHash(), source: 'body-hash' };
}

/**
 * Sanitize a dedupe key for use as a KV suffix (sha256 hex of the key).
 * Weird chars in Idempotency-Key values must not break KV key names.
 */
export async function dedupeKvSuffix(dedupeKey) {
  return bodyHashHex(String(dedupeKey || ''));
}

/** KV key for a per-inbox dedupe entry. */
export async function dedupeKvKey(inboxId, dedupeKey) {
  return `dedupe:${inboxId}:${await dedupeKvSuffix(dedupeKey)}`;
}

/**
 * Maintain an inbox-scoped in-memory map (Node JSON store).
 * Mutates inbox.dedupeMap (object) + inbox.dedupeOrder (array of keys).
 * Caps at DEDUPE_MAP_MAX — drops oldest when over.
 */
export function rememberDedupe(inbox, key, eventId) {
  if (!inbox || !key || !eventId) return;
  if (!inbox.dedupeMap || typeof inbox.dedupeMap !== 'object') inbox.dedupeMap = {};
  if (!Array.isArray(inbox.dedupeOrder)) inbox.dedupeOrder = [];
  if (inbox.dedupeMap[key]) {
    // refresh position to newest
    inbox.dedupeOrder = inbox.dedupeOrder.filter((k) => k !== key);
  }
  inbox.dedupeMap[key] = eventId;
  inbox.dedupeOrder.push(key);
  while (inbox.dedupeOrder.length > DEDUPE_MAP_MAX) {
    const old = inbox.dedupeOrder.shift();
    if (old != null) delete inbox.dedupeMap[old];
  }
}

/** Look up an eventId for a dedupe key on an inbox (Node). */
export function lookupDedupe(inbox, key) {
  if (!inbox || !key || !inbox.dedupeMap) return null;
  return inbox.dedupeMap[key] || null;
}

/** Drop map entries that point at a deleted eventId (Node trim / bulk delete). */
export function forgetDedupeForEvent(inbox, eventId) {
  if (!inbox || !eventId || !inbox.dedupeMap) return;
  const drop = [];
  for (const [k, id] of Object.entries(inbox.dedupeMap)) {
    if (id === eventId) drop.push(k);
  }
  for (const k of drop) {
    delete inbox.dedupeMap[k];
    if (Array.isArray(inbox.dedupeOrder)) {
      inbox.dedupeOrder = inbox.dedupeOrder.filter((x) => x !== k);
    }
  }
}
