/**
 * Event diff — compare two captured webhook events (body + headers + meta).
 * Shared by the Node server (src/server.js / src/db.js) and Workers (workers/src/worker.js).
 * Pure ESM, zero deps.
 *
 * Typical use: "this delivery broke my n8n flow, the one before it didn't — what changed?"
 * JSON bodies are diffed structurally (dot/[index] paths); anything else falls back to a line diff.
 * Volatile per-delivery headers (signatures, request ids, dates, CDN hops) are ignored by default.
 */

export const DIFF_MAX_CHANGES = 200;
export const DIFF_VALUE_PREVIEW = 200;
export const TEXT_DIFF_MAX_LINES = 400;
export const IGNORE_MAX_PATHS = 20;

/** Headers that differ on every delivery and are noise when comparing two events. */
export const VOLATILE_HEADERS = [
  'date',
  'content-length',
  'x-request-id',
  'x-correlation-id',
  'traceparent',
  'tracestate',
  'cf-ray',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cdn-loop',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'true-client-ip',
  'x-amzn-trace-id',
  'stripe-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-github-delivery',
  'x-shopify-hmac-sha256',
  'x-shopify-webhook-id',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'svix-id',
  'svix-timestamp',
  'svix-signature',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
];

/**
 * Parse the `ignore` option: comma-separated paths (max 20). A path ignores itself and everything
 * under it; `*` matches one segment (`data.items[*].id` or `data.*.updated`).
 * Returns { ok:true, patterns } or { ok:false, error:'bad_ignore', message }.
 */
export function parseIgnore(raw) {
  if (raw == null || raw === '') return { ok: true, patterns: [] };
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const patterns = list.map((s) => String(s).trim()).filter(Boolean);
  if (patterns.length > IGNORE_MAX_PATHS)
    return { ok: false, error: 'bad_ignore', message: `ignore accepts at most ${IGNORE_MAX_PATHS} paths` };
  for (const p of patterns) {
    if (p.length > 200 || /\s/.test(p))
      return { ok: false, error: 'bad_ignore', message: `bad ignore path: ${p.slice(0, 40)}` };
  }
  return { ok: true, patterns };
}

function segmentsOf(path) {
  // "a.b[0].c" → ["a","b","[0]","c"]
  const out = [];
  for (const part of String(path).split('.')) {
    if (!part) continue;
    const m = part.match(/^([^[\]]*)((?:\[[^\]]*\])*)$/);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\[[^\]]*\]/g) || []) out.push(idx);
  }
  return out;
}

/** True when `path` equals or sits under one of the ignore patterns. */
export function isIgnored(path, patterns) {
  if (!patterns || !patterns.length) return false;
  const segs = segmentsOf(path);
  return patterns.some((p) => {
    const ps = segmentsOf(p);
    if (ps.length > segs.length) return false;
    return ps.every((s, i) => s === segs[i] || s === '*' || (s === '[*]' && /^\[\d+\]$/.test(segs[i])));
  });
}

/** Values in a diff: primitives as-is, long strings truncated, objects/arrays kept unless their JSON is long. */
function preview(v) {
  if (v === undefined) return undefined;
  const cut = (str) => (str.length > DIFF_VALUE_PREVIEW ? str.slice(0, DIFF_VALUE_PREVIEW) + '…' : str);
  if (typeof v === 'string') return cut(v);
  if (v === null || typeof v !== 'object') return v;
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    return cut(String(v));
  }
  return s.length > DIFF_VALUE_PREVIEW ? cut(s) : v;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const joinKey = (base, key) =>
  /^[A-Za-z_$][\w$-]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;

/**
 * Structural diff of two JSON values. Returns { changes, truncated, ignored }.
 * change = { path, kind: 'added'|'removed'|'changed'|'type', before?, after? }.
 */
export function diffJson(a, b, { ignore = [], max = DIFF_MAX_CHANGES } = {}) {
  const changes = [];
  let truncated = false;
  let ignored = 0;
  const push = (c) => {
    if (changes.length >= max) {
      truncated = true;
      return;
    }
    changes.push(c);
  };
  const walk = (x, y, path) => {
    if (truncated) return;
    if (path && isIgnored(path, ignore)) {
      if (JSON.stringify(x) !== JSON.stringify(y)) ignored++;
      return;
    }
    const tx = typeOf(x);
    const ty = typeOf(y);
    if (tx !== ty) {
      push({ path: path || '(root)', kind: 'type', before: preview(x), after: preview(y), beforeType: tx, afterType: ty });
      return;
    }
    if (tx === 'object') {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const k of keys) {
        const p = joinKey(path, k);
        const inX = Object.prototype.hasOwnProperty.call(x, k);
        const inY = Object.prototype.hasOwnProperty.call(y, k);
        if (inX && inY) walk(x[k], y[k], p);
        else if (isIgnored(p, ignore)) ignored++;
        else if (inY) push({ path: p, kind: 'added', after: preview(y[k]) });
        else push({ path: p, kind: 'removed', before: preview(x[k]) });
        if (truncated) return;
      }
      return;
    }
    if (tx === 'array') {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        if (i < x.length && i < y.length) walk(x[i], y[i], p);
        else if (isIgnored(p, ignore)) ignored++;
        else if (i < y.length) push({ path: p, kind: 'added', after: preview(y[i]) });
        else push({ path: p, kind: 'removed', before: preview(x[i]) });
        if (truncated) return;
      }
      return;
    }
    if (x !== y) push({ path: path || '(root)', kind: 'changed', before: preview(x), after: preview(y) });
  };
  walk(a, b, '');
  return { changes, truncated, ignored };
}

/**
 * Line diff (LCS) for non-JSON bodies. Returns { changes, truncated } where
 * change = { line (1-based in the side it belongs to), kind: 'added'|'removed', text }.
 * Falls back to index-by-index comparison when either side exceeds TEXT_DIFF_MAX_LINES.
 */
export function diffText(a, b, { max = DIFF_MAX_CHANGES } = {}) {
  const A = String(a == null ? '' : a).split('\n');
  const B = String(b == null ? '' : b).split('\n');
  const changes = [];
  let truncated = false;
  const push = (c) => {
    if (changes.length >= max) truncated = true;
    else changes.push({ ...c, text: c.text.length > DIFF_VALUE_PREVIEW ? c.text.slice(0, DIFF_VALUE_PREVIEW) + '…' : c.text });
  };
  if (A.length > TEXT_DIFF_MAX_LINES || B.length > TEXT_DIFF_MAX_LINES) {
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n && !truncated; i++) {
      if (A[i] === B[i]) continue;
      if (i < A.length) push({ line: i + 1, kind: 'removed', text: A[i] });
      if (i < B.length) push({ line: i + 1, kind: 'added', text: B[i] });
    }
    return { changes, truncated, approximate: true };
  }
  const m = A.length;
  const n = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  while ((i < m || j < n) && !truncated) {
    if (i < m && j < n && A[i] === B[j]) {
      i++;
      j++;
    } else if (j < n && (i >= m || L[i][j + 1] >= L[i + 1][j])) {
      push({ line: j + 1, kind: 'added', text: B[j] });
      j++;
    } else {
      push({ line: i + 1, kind: 'removed', text: A[i] });
      i++;
    }
  }
  return { changes, truncated, approximate: false };
}

/** Header diff (case-insensitive names). Volatile headers skipped unless allHeaders. */
export function diffHeaders(ha, hb, { allHeaders = false } = {}) {
  const norm = (h) => {
    const o = {};
    for (const [k, v] of Object.entries(h || {})) o[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return o;
  };
  const A = norm(ha);
  const B = norm(hb);
  const changes = [];
  let skipped = 0;
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    if (A[k] === B[k]) continue;
    if (!allHeaders && VOLATILE_HEADERS.includes(k)) {
      skipped++;
      continue;
    }
    if (!(k in A)) changes.push({ name: k, kind: 'added', after: preview(B[k]) });
    else if (!(k in B)) changes.push({ name: k, kind: 'removed', before: preview(A[k]) });
    else changes.push({ name: k, kind: 'changed', before: preview(A[k]), after: preview(B[k]) });
  }
  return { changes, volatileSkipped: skipped };
}

function parsedBody(ev) {
  if (ev && ev.bodyJson != null && typeof ev.bodyJson === 'object') return ev.bodyJson;
  const t = ev && ev.bodyText;
  if (typeof t === 'string' && /^\s*[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

const eventRef = (ev) => ({
  id: ev.id,
  receivedAt: ev.receivedAt,
  method: ev.method,
  pinned: Boolean(ev.pinned),
  note: ev.note || '',
});

/**
 * Compare `base` (the baseline / older event) with `target` (the event you're looking at).
 * opts: { ignore: string[] (parsed), allHeaders: boolean }
 */
export function diffEvents(base, target, { ignore = [], allHeaders = false } = {}) {
  const ja = parsedBody(base);
  const jb = parsedBody(target);
  let body;
  if (ja !== undefined && jb !== undefined) {
    const r = diffJson(ja, jb, { ignore });
    body = { mode: 'json', changes: r.changes, truncated: r.truncated, ignoredChanges: r.ignored };
  } else if ((base.bodyText || '') === (target.bodyText || '')) {
    body = { mode: 'text', changes: [], truncated: false };
  } else {
    const r = diffText(base.bodyText, target.bodyText);
    body = { mode: 'text', changes: r.changes, truncated: r.truncated, approximate: r.approximate };
  }
  const headers = diffHeaders(base.headers, target.headers, { allHeaders });
  const meta = [];
  for (const f of ['method', 'contentType', 'statusGuess', 'size', 'respondedStatus']) {
    const a = base[f] == null ? null : base[f];
    const b = target[f] == null ? null : target[f];
    if (a !== b) meta.push({ field: f, before: a, after: b });
  }
  const sa = base.signature ? base.signature.valid : null;
  const sb = target.signature ? target.signature.valid : null;
  if (sa !== sb) meta.push({ field: 'signatureValid', before: sa, after: sb });
  const count = (kind) => body.changes.filter((c) => c.kind === kind).length;
  const summary = {
    bodyAdded: count('added'),
    bodyRemoved: count('removed'),
    bodyChanged: count('changed') + count('type'),
    headersChanged: headers.changes.length,
    metaChanged: meta.length,
  };
  const identical = !body.changes.length && !headers.changes.length && !meta.length;
  return {
    ok: true,
    base: eventRef(base),
    target: eventRef(target),
    identical,
    summary,
    body,
    headers,
    meta,
    ignore,
    allHeaders: Boolean(allHeaders),
  };
}

/** Read diff options from a URLSearchParams-like getter. */
export function diffOptionsFromQuery(get) {
  const ig = parseIgnore(get('ignore'));
  if (!ig.ok) return ig;
  const h = String(get('headers') || '').toLowerCase();
  return { ok: true, against: String(get('against') || '').trim(), ignore: ig.patterns, allHeaders: h === 'all' || h === '1' };
}

/**
 * The event received just before `target` among `events` (given oldest-first / insertion order).
 * Stable sort on receivedAt so same-millisecond captures keep their insertion order.
 */
export function previousEvent(events, target) {
  const sorted = events
    .map((e, i) => [e, i])
    .sort((x, y) => (x[0].receivedAt < y[0].receivedAt ? -1 : x[0].receivedAt > y[0].receivedAt ? 1 : x[1] - y[1]))
    .map((x) => x[0]);
  const idx = sorted.findIndex((e) => e.id === target.id);
  return idx > 0 ? sorted[idx - 1] : null;
}
