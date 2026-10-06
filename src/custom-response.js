/**
 * Hookkeep — per-inbox custom ingest response (shared by Node server + Workers).
 *
 * Lets an operator choose what HTTP response the public /hook/:inboxId URL sends
 * back to the webhook provider: e.g. return 500/503 to exercise the provider's
 * retry logic, 410 to see how it handles a gone endpoint, or echo a handshake
 * value (Slack url_verification `{{json.challenge}}`).
 *
 * Inbox fields (all optional; unset/0 status = default Hookkeep JSON ack):
 *   responseStatus       integer 200–599, or 0/null to disable
 *   responseBody         string ≤ 10,000 chars; supports {{eventId}}, {{method}},
 *                        {{receivedAt}}, {{json.some.path}} placeholders
 *   responseContentType  string ≤ 120 chars (default application/json when the
 *                        body looks like JSON, else text/plain; charset=utf-8)
 *
 * Zero deps — safe to bundle into the Worker.
 */

export const RESPONSE_BODY_MAX = 10_000;
export const RESPONSE_CT_MAX = 120;
const NO_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Validate a PATCH body's custom-response fields.
 * Returns { ok: true, patch } with normalized values to assign onto the inbox
 * (only keys present in body), or { ok: false, error, message }.
 */
export function normalizeResponsePatch(body = {}) {
  const patch = {};
  if (body.responseStatus !== undefined) {
    const raw = body.responseStatus;
    if (raw === null || raw === '' || raw === 0 || raw === '0') {
      patch.responseStatus = 0;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 200 || n > 599) {
        return {
          ok: false,
          error: 'bad_response_status',
          message: 'responseStatus must be an integer 200–599 (or 0/null to use the default ack)',
        };
      }
      patch.responseStatus = n;
    }
  }
  if (body.responseBody !== undefined) {
    patch.responseBody = body.responseBody == null ? '' : String(body.responseBody).slice(0, RESPONSE_BODY_MAX);
  }
  if (body.responseContentType !== undefined) {
    patch.responseContentType =
      body.responseContentType == null
        ? ''
        : String(body.responseContentType).replace(/[\r\n]/g, '').trim().slice(0, RESPONSE_CT_MAX);
  }
  return { ok: true, patch };
}

/** Public view of the custom-response config for an inbox. */
export function publicResponseConfig(inbox = {}) {
  return {
    responseStatus: Number(inbox.responseStatus) || 0,
    responseBody: inbox.responseBody || '',
    responseContentType: inbox.responseContentType || '',
  };
}

function lookupPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Render {{eventId}} / {{method}} / {{receivedAt}} / {{json.a.b}} placeholders. */
export function renderResponseTemplate(template, { eventId = '', method = '', receivedAt = '', json = null } = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    if (key === 'eventId') return eventId;
    if (key === 'method') return method;
    if (key === 'receivedAt') return receivedAt;
    if (key.startsWith('json.')) {
      const v = lookupPath(json, key.slice(5));
      if (v == null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return '';
  });
}

/**
 * Build the custom ingest response for an inbox + captured event, or null when
 * the inbox uses the default Hookkeep ack.
 * Returns { status, contentType, body } (body null for 204/205/304).
 */
export function buildCustomResponse(inbox, event = {}) {
  const status = Number(inbox && inbox.responseStatus) || 0;
  if (!status || status < 200 || status > 599) return null;
  if (NO_BODY_STATUSES.has(status)) {
    return { status, contentType: '', body: null };
  }
  const body = renderResponseTemplate(inbox.responseBody || '', {
    eventId: event.id || '',
    method: event.method || '',
    receivedAt: event.receivedAt || '',
    json: event.bodyJson ?? null,
  });
  let contentType = String(inbox.responseContentType || '').trim();
  if (!contentType) {
    const t = body.trim();
    contentType =
      t && (t.startsWith('{') || t.startsWith('['))
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8';
  }
  return { status, contentType, body };
}
