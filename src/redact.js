/**
 * Hookkeep — per-inbox capture redaction (shared by Node server + Workers).
 *
 * Webhook catchers often store secrets (Authorization, API keys in JSON). With
 * inbox `redactHeaders` / `redactJsonPaths`, matching header names and JSON body
 * paths are replaced with "[REDACTED]" on a copy used for storage and auto-forward.
 * Signature verify + dedupe still use the raw request.
 *
 * Pure ESM, zero deps.
 */

export const REDACT_PLACEHOLDER = '[REDACTED]';
export const REDACT_HEADERS_MAX = 40;
export const REDACT_HEADER_LEN_MAX = 80;
export const REDACT_JSON_PATHS_MAX = 40;
export const REDACT_JSON_PATH_LEN_MAX = 120;

/** Header name: letters, digits, - or _; case-insensitive; stored lowercase. */
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/**
 * JSON path segment: identifier or [index]. Full path = segments joined by `.`
 * with optional `[n]` after a name (e.g. data.items[0].secret, [0].key).
 */
const JSON_PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|\[\d+\])(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*$/;

/**
 * Split a PATCH value into a string list: array, or comma/newline-separated string.
 */
export function splitListInput(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return String(v)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize header name → lowercase, or null if invalid. Empty → null (skip). */
export function normalizeRedactHeaderName(v) {
  if (v == null) return null;
  const h = String(v).trim().toLowerCase();
  if (!h) return null;
  if (h.length > REDACT_HEADER_LEN_MAX || !HEADER_NAME_RE.test(h)) return null;
  return h;
}

/** Validate a JSON path string, or null if unusable. */
export function normalizeRedactJsonPath(v) {
  if (v == null) return null;
  const p = String(v).trim();
  if (!p) return null;
  if (p.length > REDACT_JSON_PATH_LEN_MAX) return null;
  if (/\s/.test(p)) return null;
  if (!JSON_PATH_RE.test(p)) return null;
  return p;
}

/**
 * Validate a PATCH body's redaction fields.
 * Returns { ok: true, patch } (only keys present) or { ok: false, error, message }.
 */
export function normalizeRedactPatch(body = {}) {
  const patch = {};
  if (body.redactHeaders !== undefined) {
    const raw = splitListInput(body.redactHeaders);
    if (raw.length > REDACT_HEADERS_MAX) {
      return {
        ok: false,
        error: 'bad_redact_headers',
        message: `redactHeaders accepts at most ${REDACT_HEADERS_MAX} names`,
      };
    }
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const h = normalizeRedactHeaderName(item);
      if (h == null) {
        return {
          ok: false,
          error: 'bad_redact_headers',
          message: `bad redactHeaders name: ${String(item).slice(0, 40)}`,
        };
      }
      if (!seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
    patch.redactHeaders = out;
  }
  if (body.redactJsonPaths !== undefined) {
    const raw = splitListInput(body.redactJsonPaths);
    if (raw.length > REDACT_JSON_PATHS_MAX) {
      return {
        ok: false,
        error: 'bad_redact_json_paths',
        message: `redactJsonPaths accepts at most ${REDACT_JSON_PATHS_MAX} paths`,
      };
    }
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const p = normalizeRedactJsonPath(item);
      if (p == null) {
        return {
          ok: false,
          error: 'bad_redact_json_paths',
          message: `bad redactJsonPaths path: ${String(item).slice(0, 40)}`,
        };
      }
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    patch.redactJsonPaths = out;
  }
  return { ok: true, patch };
}

/** Public view of redaction config for an inbox. */
export function publicRedactConfig(inbox = {}) {
  const headers = Array.isArray(inbox.redactHeaders)
    ? inbox.redactHeaders.filter((h) => typeof h === 'string' && h)
    : [];
  const jsonPaths = Array.isArray(inbox.redactJsonPaths)
    ? inbox.redactJsonPaths.filter((p) => typeof p === 'string' && p)
    : [];
  return { redactHeaders: headers, redactJsonPaths: jsonPaths };
}

/**
 * Parse "a.b[0].c" → ["a","b",0,"c"] (numbers for indices).
 * Returns null if the path cannot be parsed.
 */
export function parseJsonPath(path) {
  const p = normalizeRedactJsonPath(path);
  if (p == null) return null;
  const segs = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '.') {
      i += 1;
      continue;
    }
    if (p[i] === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) return null;
      const n = Number(p.slice(i + 1, close));
      if (!Number.isInteger(n) || n < 0) return null;
      segs.push(n);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < p.length && /[A-Za-z0-9_]/.test(p[j])) j += 1;
    if (j === i) return null;
    segs.push(p.slice(i, j));
    i = j;
  }
  return segs.length ? segs : null;
}

/**
 * Deep-clone JSON-compatible value via structuredClone or JSON round-trip.
 */
function cloneJson(v) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(v));
}

/**
 * Set path on object/array to placeholder. Returns true if the path existed and was set.
 */
export function setJsonPath(root, path, value = REDACT_PLACEHOLDER) {
  const segs = parseJsonPath(path);
  if (!segs || root == null || typeof root !== 'object') return false;
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur == null || typeof cur !== 'object') return false;
    if (Array.isArray(cur)) {
      if (typeof s !== 'number' || s < 0 || s >= cur.length) return false;
    } else if (!(s in cur)) {
      return false;
    }
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (cur == null || typeof cur !== 'object') return false;
  if (Array.isArray(cur)) {
    if (typeof last !== 'number' || last < 0 || last >= cur.length) return false;
  } else if (!(last in cur)) {
    return false;
  }
  cur[last] = value;
  return true;
}

/**
 * Case-insensitive: copy headers object, set matching names to placeholder.
 * Returns { headers, applied } where applied is lowercase names that matched.
 */
export function redactHeadersCopy(headers, names) {
  const list = Array.isArray(names) ? names.map((n) => String(n).toLowerCase()).filter(Boolean) : [];
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      out[k] = v;
    }
  }
  const applied = [];
  if (!list.length) return { headers: out, applied };
  const want = new Set(list);
  for (const [k, v] of Object.entries(out)) {
    const lk = k.toLowerCase();
    if (want.has(lk)) {
      out[k] = REDACT_PLACEHOLDER;
      if (!applied.includes(lk)) applied.push(lk);
    }
  }
  return { headers: out, applied };
}

/**
 * If bodyText parses as JSON object/array, redact paths and re-serialize.
 * Non-JSON → unchanged body (header redaction only).
 * Returns { bodyText, bodyJson, contentType, size, applied }.
 */
export function redactJsonBody(bodyText, contentType, paths) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  const raw = bodyText == null ? '' : String(bodyText);
  const ct = contentType || '';
  const applied = [];
  if (!list.length) {
    return { bodyText: raw, bodyJson: null, contentType: ct, size: null, applied, parsed: false };
  }
  let parsed = null;
  try {
    if (raw && (ct.includes('json') || raw.trim().startsWith('{') || raw.trim().startsWith('['))) {
      parsed = JSON.parse(raw);
    }
  } catch {
    parsed = null;
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { bodyText: raw, bodyJson: null, contentType: ct, size: null, applied, parsed: false };
  }
  const clone = cloneJson(parsed);
  for (const path of list) {
    if (setJsonPath(clone, path, REDACT_PLACEHOLDER)) {
      if (!applied.includes(path)) applied.push(path);
    }
  }
  const nextText = JSON.stringify(clone);
  const nextCt = ct.includes('json') ? ct : 'application/json';
  // size: UTF-8 byte length when Buffer available, else string length (Workers)
  let size = nextText.length;
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) {
    size = Buffer.byteLength(nextText, 'utf8');
  } else if (typeof TextEncoder !== 'undefined') {
    size = new TextEncoder().encode(nextText).byteLength;
  }
  return {
    bodyText: nextText,
    bodyJson: clone,
    contentType: nextCt,
    size,
    applied,
    parsed: true,
  };
}

/**
 * Apply inbox redaction config to a capture copy (headers + body).
 * Does not mutate inputs. Returns { headers, bodyText, bodyJson, contentType, size, redaction }.
 * `redaction` is null when nothing was configured / applied.
 */
export function applyCaptureRedaction(inbox, { headers, bodyText, contentType, size } = {}) {
  const cfg = publicRedactConfig(inbox || {});
  const hdr = redactHeadersCopy(headers, cfg.redactHeaders);
  const body = redactJsonBody(bodyText, contentType, cfg.redactJsonPaths);

  let nextBodyText = bodyText == null ? '' : String(bodyText);
  let nextBodyJson = undefined; // undefined = caller should parse; null = explicit empty
  let nextCt = contentType || '';
  let nextSize = size;
  let bodyWasRedacted = false;

  if (body.parsed && body.applied.length) {
    nextBodyText = body.bodyText;
    nextBodyJson = body.bodyJson;
    nextCt = body.contentType;
    nextSize = body.size;
    bodyWasRedacted = true;
  }

  const redaction =
    hdr.applied.length || body.applied.length
      ? { headers: hdr.applied.slice(), jsonPaths: body.applied.slice() }
      : null;

  return {
    headers: hdr.headers,
    bodyText: nextBodyText.slice(0, 200_000),
    bodyJson: bodyWasRedacted ? nextBodyJson : undefined,
    contentType: nextCt,
    size: nextSize,
    redaction,
  };
}

/** Compact summary for list/export rows. */
export function publicRedactionSummary(e) {
  const r = e && e.redaction;
  if (!r || typeof r !== 'object') return null;
  const headers = Array.isArray(r.headers) ? r.headers : [];
  const jsonPaths = Array.isArray(r.jsonPaths) ? r.jsonPaths : [];
  if (!headers.length && !jsonPaths.length) return null;
  return { headers, jsonPaths };
}
