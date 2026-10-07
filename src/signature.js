/**
 * Hookkeep — per-inbox webhook signature verification (shared by Node server + Workers).
 *
 * Providers sign each delivery; until now Hookkeep only displayed those headers.
 * With an inbox `signingScheme` + `signingSecret`, every capture on /hook/:inboxId
 * is checked against the RAW body bytes exactly as received, and the event records
 *   signature: { scheme, valid, reason, timestampSkewSec? }
 * Capture is ALWAYS stored, and the ingest response is never changed by the result.
 *
 * Schemes:
 *   none          (default) — no check, no `signature` field on events
 *   stripe        `stripe-signature: t=<unix>,v1=<hex>[,v1=<hex>…]`
 *                 HMAC-SHA256(secret, `${t}.${rawBody}`), tolerance 300s
 *   github        `x-hub-signature-256: sha256=<hex>` = HMAC-SHA256(secret, rawBody)
 *   hmac-sha256   `<signingHeader>` (default x-signature): `<hex>` or `sha256=<hex>`
 *
 * Reasons: ok · missing_header · bad_format · mismatch · timestamp_out_of_tolerance · no_secret
 *
 * The secret is write-only: public views expose only `hasSigningSecret` and a
 * masked hint (last 4 chars, only for secrets ≥ 12 chars).
 *
 * Pure ESM, zero deps — WebCrypto via globalThis.crypto.subtle (Node ≥ 18 + Workers).
 */

export const SIGNING_SCHEMES = ['none', 'stripe', 'github', 'hmac-sha256'];
export const SIGNING_SECRET_MAX = 500;
export const SIGNING_HEADER_DEFAULT = 'x-signature';
export const STRIPE_TOLERANCE_SEC = 300;
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const enc = new TextEncoder();

/**
 * Validate a PATCH body's signature fields.
 * Returns { ok: true, patch } (only keys present in body) or { ok: false, error, message }.
 * `signingSecret: ''|null` clears the secret.
 */
export function normalizeSignaturePatch(body = {}) {
  const patch = {};
  if (body.signingScheme !== undefined) {
    const s = body.signingScheme == null || body.signingScheme === '' ? 'none' : String(body.signingScheme).trim().toLowerCase();
    if (!SIGNING_SCHEMES.includes(s)) {
      return {
        ok: false,
        error: 'bad_signing_scheme',
        message: `signingScheme must be one of ${SIGNING_SCHEMES.join(' | ')}`,
      };
    }
    patch.signingScheme = s;
  }
  if (body.signingSecret !== undefined) {
    const sec = body.signingSecret == null ? '' : String(body.signingSecret);
    if (sec.length > SIGNING_SECRET_MAX) {
      return {
        ok: false,
        error: 'bad_signing_secret',
        message: `signingSecret must be at most ${SIGNING_SECRET_MAX} characters`,
      };
    }
    patch.signingSecret = sec;
  }
  if (body.signingHeader !== undefined) {
    const h = body.signingHeader == null ? '' : String(body.signingHeader).trim().toLowerCase();
    if (h && !HEADER_NAME_RE.test(h)) {
      return {
        ok: false,
        error: 'bad_signing_header',
        message: 'signingHeader must be a header name (letters, digits, - or _; ≤ 100 chars)',
      };
    }
    patch.signingHeader = h;
  }
  return { ok: true, patch };
}

/** Masked hint for a stored secret — never the secret itself. */
export function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return s.length >= 12 ? `••••${s.slice(-4)}` : '••••';
}

/** Public view of the signature config for an inbox (secret never included). */
export function publicSignatureConfig(inbox = {}) {
  const scheme = SIGNING_SCHEMES.includes(inbox.signingScheme) ? inbox.signingScheme : 'none';
  return {
    signingScheme: scheme,
    signingHeader: inbox.signingHeader || (scheme === 'hmac-sha256' ? SIGNING_HEADER_DEFAULT : ''),
    hasSigningSecret: Boolean(inbox.signingSecret),
    signingSecretHint: maskSecret(inbox.signingSecret),
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const want = name.toLowerCase();
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

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256(secret, data) → lowercase hex. */
export async function hmacSha256Hex(secret, data) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('webcrypto_unavailable');
  const key = await subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toHex(await subtle.sign('HMAC', key, toBytes(data)));
}

/** Constant-time compare of two equal-length strings (length mismatch → false). */
export function timingSafeEqualStr(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Parse `t=…,v1=…,v1=…` → { t, v1: [] } or null on bad format. */
export function parseStripeHeader(value) {
  let t = null;
  const v1 = [];
  for (const part of String(value || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v.toLowerCase());
  }
  if (t == null || !/^\d{1,12}$/.test(t)) return null;
  const sigs = v1.filter((s) => HEX64_RE.test(s));
  if (!sigs.length) return null;
  return { t: Number(t), v1: sigs };
}

function parseHexDigest(value) {
  let v = String(value || '').trim();
  if (/^sha256=/i.test(v)) v = v.slice(7);
  v = v.toLowerCase();
  return HEX64_RE.test(v) ? v : null;
}

/**
 * Verify a captured delivery against the inbox config.
 * @param inbox   stored inbox (with signingScheme / signingSecret / signingHeader)
 * @param opts    { headers (object or Headers), rawBody (bytes | string), nowMs? }
 * @returns null when scheme is none, else { scheme, valid, reason, header, timestampSkewSec? }
 * Never throws.
 */
export async function verifySignature(inbox, { headers, rawBody, nowMs = Date.now() } = {}) {
  const scheme = inbox && SIGNING_SCHEMES.includes(inbox.signingScheme) ? inbox.signingScheme : 'none';
  if (scheme === 'none') return null;
  const header =
    scheme === 'stripe'
      ? 'stripe-signature'
      : scheme === 'github'
        ? 'x-hub-signature-256'
        : inbox.signingHeader || SIGNING_HEADER_DEFAULT;
  const result = (valid, reason, extra = {}) => ({ scheme, valid, reason, header, ...extra });
  const secret = String((inbox && inbox.signingSecret) || '');
  try {
    const value = headerValue(headers, header);
    if (!value) return result(false, 'missing_header');
    if (!secret) return result(false, 'no_secret');
    const body = toBytes(rawBody);

    if (scheme === 'stripe') {
      const parsed = parseStripeHeader(value);
      if (!parsed) return result(false, 'bad_format');
      const timestampSkewSec = Math.round(nowMs / 1000) - parsed.t;
      const expected = await hmacSha256Hex(secret, concatBytes(enc.encode(`${parsed.t}.`), body));
      let match = false;
      for (const sig of parsed.v1) {
        if (timingSafeEqualStr(sig, expected)) match = true;
      }
      if (!match) return result(false, 'mismatch', { timestampSkewSec });
      if (Math.abs(timestampSkewSec) > STRIPE_TOLERANCE_SEC) {
        return result(false, 'timestamp_out_of_tolerance', { timestampSkewSec });
      }
      return result(true, 'ok', { timestampSkewSec });
    }

    if (scheme === 'github' && !/^sha256=/i.test(value.trim())) return result(false, 'bad_format');
    const given = parseHexDigest(value);
    if (!given) return result(false, 'bad_format');
    const expected = await hmacSha256Hex(secret, body);
    return timingSafeEqualStr(given, expected) ? result(true, 'ok') : result(false, 'mismatch');
  } catch (e) {
    return result(false, 'error', { message: String((e && e.message) || e).slice(0, 120) });
  }
}

/** Compact one-line label for list rows / CSV ("ok", "mismatch", …) or ''. */
export function signatureLabel(sig) {
  if (!sig || typeof sig !== 'object') return '';
  return String(sig.reason || (sig.valid ? 'ok' : 'invalid'));
}
