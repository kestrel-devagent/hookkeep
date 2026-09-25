/**
 * Hookkeep — Cloudflare Workers + KV port (Kestrel Ops)
 * Mirrors src/server.js API shapes. Zero npm deps — plain fetch handler.
 *
 * KV layout (binding HOOKKEEP_KV):
 *   tok:<ownerToken>          -> workspace id
 *   ws:<wsId>                 -> workspace object
 *   ws:<wsId>:inboxes         -> JSON array of inbox ids
 *   inbox:<inboxId>           -> inbox object
 *   evt:<inboxId>:<revTs>_<rand> -> event object (keys sort newest-first)
 *   wait:<email>              -> waitlist entry
 *   email:<email>             -> workspace id (for billing fulfill lookup)
 *   code:<CODE>               -> unlock code entry { tier, usedBy, note }
 */

const TIERS = {
  free: { name: 'Free', maxInboxes: 1, maxEventsKeep: 50, maxEventsMonth: 500, alerts: false },
  paid: { name: 'Pro', maxInboxes: 5, maxEventsKeep: 5000, maxEventsMonth: 5000, alerts: true },
};

// Demo/launch codes — real codes should be written to KV (see README).
const BUILTIN_CODES = {
  'HOOKKEEP-PRO-DEMO01': { tier: 'paid', note: 'demo' },
  'HOOKKEEP-PRO-KESTREL': { tier: 'paid', note: 'launch' },
};

const rand = (n) => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => a[b % a.length]).join('');
};

const REV_EPOCH = 99999999999999; // ms — larger than any realistic Date.now()
const evKey = (inboxId, ts, id) =>
  `evt:${inboxId}:${String(REV_EPOCH - ts).padStart(14, '0')}_${id}`;
const alKey = (inboxId, ts, id) =>
  `alert:${inboxId}:${String(REV_EPOCH - ts).padStart(14, '0')}_${id}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function rolloverMonth(ws) {
  const mk = monthKey();
  if (ws.month !== mk) {
    ws.month = mk;
    ws.eventsThisMonth = 0;
  }
}

function publicWorkspace(ws) {
  const limits = TIERS[ws.tier] || TIERS.free;
  rolloverMonth(ws);
  return {
    id: ws.id,
    email: ws.email,
    label: ws.label,
    tier: ws.tier,
    tierName: limits.name,
    limits,
    eventsThisMonth: ws.eventsThisMonth || 0,
    unlockedAt: ws.unlockedAt,
    createdAt: ws.createdAt,
  };
}
function publicInbox(inbox) {
  return {
    id: inbox.id,
    name: inbox.name,
    forwardUrl: inbox.forwardUrl || '',
    autoForward: Boolean(inbox.autoForward),
    alertKeyword: inbox.alertKeyword || '',
    alertEmail: inbox.alertEmail || '',
    notifyWebhookUrl: inbox.notifyWebhookUrl || '',
    eventCount: inbox.eventCount || 0,
    createdAt: inbox.createdAt,
  };
}
function summarizeEvent(e) {
  return {
    id: e.id,
    inboxId: e.inboxId,
    method: e.method,
    receivedAt: e.receivedAt,
    size: e.size,
    statusGuess: e.statusGuess,
    preview: (e.bodyText || '').slice(0, 160),
    contentType: e.contentType,
  };
}

const BODY_EXPORT_MAX = 8192;
const BODY_CSV_PREVIEW = 200;

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
  if (e.path) out.path = e.path;
  if (e.url) out.url = e.url;
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

function escapeCsvField(val) {
  const s = val == null ? '' : String(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function eventsToCsv(events) {
  const header = ['id', 'receivedAt', 'method', 'status', 'contentType', 'bodyPreview', 'autoForwardOk'];
  const lines = [header.join(',')];
  for (const e of events) {
    const body = String(e.bodyText || '');
    const preview = body.slice(0, BODY_CSV_PREVIEW);
    const af =
      e.autoForward && typeof e.autoForward === 'object'
        ? e.autoForward.ok
          ? 'true'
          : 'false'
        : '';
    lines.push(
      [
        escapeCsvField(e.id),
        escapeCsvField(e.receivedAt),
        escapeCsvField(e.method),
        escapeCsvField(e.statusGuess != null ? e.statusGuess : ''),
        escapeCsvField(e.contentType || ''),
        escapeCsvField(preview),
        escapeCsvField(af),
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/** Collect filtered raw events (same predicates as list path). */
async function collectFilteredEvents(kv, inboxId, limits, { q, methodFilter, statusMin, cap }) {
  const listed = await kv.list({ prefix: `evt:${inboxId}:`, limit: limits.maxEventsKeep });
  const events = [];
  for (const k of listed.keys) {
    if (events.length >= cap) break;
    const ev = await kv.get(k.name, 'json');
    if (!ev) continue;
    if (q) {
      const hay =
        (ev.bodyText || '').toLowerCase().includes(q) ||
        (ev.statusGuess || '').toLowerCase().includes(q) ||
        (ev.method || '').toLowerCase().includes(q) ||
        String(ev.id || '').includes(q);
      if (!hay) continue;
    }
    if (methodFilter && String(ev.method || '').toUpperCase() !== methodFilter) continue;
    if (statusMin != null && !Number.isNaN(statusMin)) {
      const n = Number(String(ev.statusGuess ?? '').trim());
      if (Number.isNaN(n) || n < statusMin) continue;
    }
    events.push(ev);
  }
  return events;
}
// ---- Pro alerts: keyword match OR HTTP status >= 400 → notify webhook + log ----

function extractHttpStatus(event) {
  const pj = event.bodyJson;
  if (pj && typeof pj === 'object') {
    for (const k of ['status', 'statusCode', 'httpStatus', 'code']) {
      const v = pj[k];
      const n =
        typeof v === 'number'
          ? v
          : typeof v === 'string' && /^\d{3}$/.test(v.trim())
            ? Number(v.trim())
            : NaN;
      if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
    }
  }
  if (event.statusGuess != null) {
    const n = Number(String(event.statusGuess).trim());
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  const body = event.bodyText || '';
  const m =
    /"(?:status|statusCode|httpStatus|code)"\s*:\s*"?(\d{3})"?/i.exec(body) ||
    /\b(?:status|statusCode|httpStatus)\s*[:=]\s*"?(\d{3})"?/i.exec(body);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) return n;
  }
  return null;
}

function alertMatches(inbox, event) {
  const kw = String(inbox.alertKeyword || '').trim();
  if (kw) {
    const kwl = kw.toLowerCase();
    if (
      (event.bodyText || '').toLowerCase().includes(kwl) ||
      (event.statusGuess && String(event.statusGuess).toLowerCase().includes(kwl))
    ) {
      return { reason: 'keyword', value: kw };
    }
  }
  const status = extractHttpStatus(event);
  if (status != null && status >= 400) return { reason: 'status', value: status };
  return null;
}

function buildAlertRecord(ws, inbox, event, match) {
  const to = inbox.alertEmail || ws.email || 'hudson.gouge@projxon.ai';
  const preview = (event.bodyText || '').slice(0, 300);
  const subject = `Hookkeep alert: ${inbox.name || inbox.id} (${match.reason}=${match.value})`;
  const body = [
    'Hookkeep alert fired',
    `Inbox: ${inbox.name || inbox.id} (${inbox.id})`,
    `Event: ${event.id}`,
    `Reason: ${match.reason} -> ${match.value}`,
    `Received: ${event.receivedAt}`,
    `Preview: ${preview}`,
  ].join('\n');
  return {
    id: 'al_' + rand(16),
    inboxId: inbox.id,
    inboxName: inbox.name || '',
    workspaceId: ws.id,
    eventId: event.id,
    reason: match.reason,
    matchedValue: match.value,
    preview,
    receivedAt: event.receivedAt,
    notifyWebhookUrl: inbox.notifyWebhookUrl || '',
    mailtoHint: `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    at: new Date().toISOString(),
  };
}

async function sendNotifyWebhook(url, record) {
  let dest;
  try {
    dest = new URL(url);
  } catch {
    return { ok: false, error: 'bad_url' };
  }
  const isLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(dest.hostname);
  if (dest.protocol !== 'https:' && !(dest.protocol === 'http:' && isLocal)) {
    return { ok: false, error: 'bad_protocol' };
  }
  const content = [
    `Hookkeep alert: ${record.inboxName || record.inboxId}`,
    `reason=${record.reason} value=${record.matchedValue}`,
    `event=${record.eventId} inbox=${record.inboxId}`,
    `receivedAt=${record.receivedAt}`,
    `preview: ${record.preview}`,
  ]
    .join('\n')
    .slice(0, 1900);
  try {
    const res = await fetch(dest.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        username: 'Hookkeep Alerts',
        hookkeep: {
          inboxId: record.inboxId,
          inboxName: record.inboxName,
          eventId: record.eventId,
          reason: record.reason,
          matchedValue: record.matchedValue,
          receivedAt: record.receivedAt,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: 'webhook_failed', message: String(e.message || e) };
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    out[k] = ['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(lk)
      ? '[redacted]'
      : String(v).slice(0, 500);
  }
  return out;
}

async function getWorkspaceByToken(kv, token) {
  if (!token) return null;
  const wsId = await kv.get(`tok:${token}`);
  if (!wsId) return null;
  return kv.get(`ws:${wsId}`, 'json');
}
async function saveWorkspace(kv, ws) {
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws));
}
async function listInboxIds(kv, wsId) {
  return (await kv.get(`ws:${wsId}:inboxes`, 'json')) || [];
}
async function getInbox(kv, inboxId) {
  return kv.get(`inbox:${inboxId}`, 'json');
}

/** Resolve workspace by id or email (email via email:<em> index). */
async function getWorkspaceByIdOrEmail(kv, { workspaceId, email } = {}) {
  if (workspaceId) {
    const ws = await kv.get(`ws:${workspaceId}`, 'json');
    if (ws) return ws;
  }
  const em = String(email || '').trim().toLowerCase();
  if (em) {
    const id = await kv.get(`email:${em}`);
    if (id) return kv.get(`ws:${id}`, 'json');
  }
  return null;
}

/**
 * Pure fulfill auth gate (mirrored in scripts/workers-fulfill-unit.js).
 * envSecret = FULFILL_SECRET || HOOKKEEP_FULFILL_SECRET
 */
function fulfillAuthCheck(envSecret, headerSecret) {
  if (!envSecret) return { ok: false, status: 503, error: 'fulfill_not_configured' };
  if (String(headerSecret || '') !== String(envSecret))
    return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true, status: 200 };
}

/**
 * Resolve code from body: prefer explicit code, else mint from sessionId.
 * mintFn(sessionId) -> code string (caller persists).
 */
function resolveFulfillCode(body, mintFn) {
  let code = String(body.code || '').trim();
  if (!code && body.sessionId) {
    code = mintFn(body.sessionId);
  }
  if (!code) return { error: 'need_code_or_session' };
  return { code };
}

function mintUnlockCodeString(sessionId) {
  return 'HOOKKEEP-PRO-' + rand(8).toUpperCase();
}

/** Redeem unlock code onto workspace; mutates ws + returns entry for KV put. */
async function redeemUnlockOnWorkspace(kv, ws, code) {
  const key = String(code || '').trim().toUpperCase();
  const entry =
    (await kv.get(`code:${key}`, 'json')) ||
    (BUILTIN_CODES[key] ? { ...BUILTIN_CODES[key] } : null);
  if (!entry) {
    const err = new Error('invalid_code');
    err.code = 'invalid_code';
    throw err;
  }
  const reusable =
    entry.reusable === true || String(entry.note || '').toLowerCase().includes('demo');
  if (entry.usedBy && entry.usedBy !== ws.id && !reusable) {
    const err = new Error('code_used');
    err.code = 'code_used';
    throw err;
  }
  ws.tier = entry.tier || 'paid';
  ws.unlockedAt = new Date().toISOString();
  ws.unlockCode = key;
  if (!reusable) {
    entry.usedBy = ws.id;
    entry.usedAt = ws.unlockedAt;
  } else {
    entry.lastUsedBy = ws.id;
    entry.lastUsedAt = ws.unlockedAt;
    entry.usedBy = null;
  }
  await Promise.all([saveWorkspace(kv, ws), kv.put(`code:${key}`, JSON.stringify(entry))]);
  return { key, entry, workspace: publicWorkspace(ws) };
}

function baseUrl(request, env) {
  const pub = (env.HOOKKEEP_PUBLIC_URL || '').replace(/\/$/, '');
  if (pub) return pub;
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}


/** Forward a captured event (manual replay or auto-forward). Never throws. */
async function forwardCapturedEvent(ev, url, { timeoutMs = 15_000, auto = false } = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, error: 'no_forward_url' };
  let dest;
  try {
    dest = new URL(target);
  } catch {
    return { ok: false, error: 'bad_url', target };
  }
  if (!['http:', 'https:'].includes(dest.protocol)) return { ok: false, error: 'bad_protocol', target };
  const headers = { 'content-type': ev.contentType || 'application/json' };
  for (const [k, v] of Object.entries(ev.headers || {})) {
    const lk = k.toLowerCase();
    if (
      ['user-agent', 'x-request-id', 'x-correlation-id', 'stripe-signature', 'x-hub-signature-256'].includes(lk)
    )
      headers[k] = v;
  }
  headers['x-hookkeep-replay'] = '1';
  headers['x-hookkeep-event-id'] = ev.id;
  if (auto) headers['x-hookkeep-auto-forward'] = '1';
  const started = Date.now();
  try {
    const res = await fetch(target, {
      method: ev.method === 'GET' ? 'POST' : ev.method || 'POST',
      headers,
      body: ev.bodyText || '',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const textBody = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bodyPreview: textBody.slice(0, 2000),
      target,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'forward_failed',
      message: String(e.message || e),
      ms: Date.now() - started,
      target,
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const kv = env.HOOKKEEP_KV;
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': '*',
          'access-control-allow-headers': '*',
        },
      });
    }

    const token =
      request.headers.get('x-hookkeep-token') ||
      url.searchParams.get('token') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      '';
    const requireWs = async () => getWorkspaceByToken(kv, token);
    const bodyJson = async () => request.json().catch(() => ({}));

    try {
      // ---- Public ingest: ANY /hook/:inboxId(/*) ----
      if (path.startsWith('/hook/')) {
        const inboxId = path.split('/')[2];
        const inbox = await getInbox(kv, inboxId);
        if (!inbox) return json({ ok: false, error: 'unknown_inbox' }, 404);

        const ws = await kv.get(`ws:${inbox.workspaceId}`, 'json');
        if (!ws) return json({ ok: false, error: 'workspace_missing' }, 404);
        rolloverMonth(ws);
        const limits = TIERS[ws.tier] || TIERS.free;

        const bodyText = await request.text();
        const headers = {};
        request.headers.forEach((v, k) => (headers[k] = v));
        const contentType = request.headers.get('content-type') || '';

        let parsed = null;
        try {
          if (bodyText && contentType.includes('json')) parsed = JSON.parse(bodyText);
          else if (bodyText && bodyText.trim().startsWith('{')) parsed = JSON.parse(bodyText);
        } catch {}

        const statusGuess =
          (parsed && (parsed.status || parsed.statusCode || parsed.error || parsed.level)) || null;
        const ts = Date.now();
        const eventId = 'ev_' + rand(16);
        const event = {
          id: eventId,
          inboxId,
          method: request.method,
          headers: sanitizeHeaders(headers),
          bodyText: String(bodyText || '').slice(0, 200_000),
          bodyJson: parsed,
          contentType,
          statusGuess: statusGuess != null ? String(statusGuess).slice(0, 80) : null,
          receivedAt: new Date(ts).toISOString(),
          size: new TextEncoder().encode(bodyText || '').length,
        };

        inbox.eventCount = (inbox.eventCount || 0) + 1;
        ws.eventsThisMonth = (ws.eventsThisMonth || 0) + 1;

        // Pro alerts: keyword match OR status >= 400 → notify webhook + console log
        let alert = null;
        let alertRecord = null;
        if (limits.alerts) {
          const match = alertMatches(inbox, event);
          if (match) {
            alertRecord = buildAlertRecord(ws, inbox, event, match);
            console.log('[hookkeep:alert]', JSON.stringify(alertRecord));
            alert = {
              matched: true,
              reason: alertRecord.reason,
              matchedValue: alertRecord.matchedValue,
              queued: true,
              mailtoHint: alertRecord.mailtoHint,
              webhookAttempted: Boolean(alertRecord.notifyWebhookUrl),
            };
          }
        }

        if (alertRecord) {
          ctx.waitUntil(kv.put(alKey(inboxId, ts, alertRecord.id), JSON.stringify(alertRecord), { expirationTtl: 60 * 60 * 24 * 30 }));
        }

        if (alertRecord && alertRecord.notifyWebhookUrl) {
          ctx.waitUntil(
            sendNotifyWebhook(alertRecord.notifyWebhookUrl, alertRecord).then((r) => {
              if (!r.ok) console.log('[hookkeep:alert] webhook failed', JSON.stringify(r));
            })
          );
        }

        const autoForwardTarget =
          inbox.autoForward && String(inbox.forwardUrl || '').trim()
            ? String(inbox.forwardUrl).trim()
            : null;

        ctx.waitUntil(
          (async () => {
            // Auto-forward before final put so event record includes result
            if (autoForwardTarget) {
              const fwd = await forwardCapturedEvent(event, autoForwardTarget, {
                timeoutMs: 8000,
                auto: true,
              });
              event.autoForward = {
                ok: Boolean(fwd.ok),
                status: fwd.status,
                ms: fwd.ms,
                target: fwd.target,
              };
              if (fwd.error) event.autoForward.error = String(fwd.error).slice(0, 80);
              if (fwd.message && !fwd.ok) event.autoForward.message = String(fwd.message).slice(0, 200);
            }
            await kv.put(evKey(inboxId, ts, eventId), JSON.stringify(event));
            await kv.put(`inbox:${inboxId}`, JSON.stringify(inbox));
            await saveWorkspace(kv, ws);
            // Trim to keep window
            const keys = await kv.list({ prefix: `evt:${inboxId}:` });
            const extra = keys.keys.slice(limits.maxEventsKeep);
            await Promise.all(extra.map((k) => kv.delete(k.name)));
          })()
        );

        const resp = {
          ok: true,
          id: eventId,
          received: true,
          alert,
          overMonth: ws.eventsThisMonth > limits.maxEventsMonth,
        };
        if (autoForwardTarget) {
          resp.autoForward = { attempted: true, queued: true, target: autoForwardTarget };
        }
        return json(resp, 200);
      }

      // ---- API ----
      if (path === '/api/health') {
        return json({ ok: true, service: 'hookkeep', brand: 'Kestrel Ops', ts: new Date().toISOString() });
      }

      if (path === '/api/pricing') {
        return json({
          free: { price: 0, inboxes: 1, eventsKeep: 50, eventsMonth: 500, alerts: false },
          paid: {
            price: 9,
            period: 'month',
            inboxes: 5,
            eventsKeep: 5000,
            eventsMonth: 5000,
            alerts: true,
            pay: {
              method: 'Stripe',
              subscribeUrl: '/subscribe?product=hookkeep',
              billingHost: (env.BILLING_PUBLIC_URL || env.STRIPE_BILLING_URL || '').replace(/\/$/, '') || null,
              note: 'Hookkeep Pro $9/mo via Stripe Checkout',
              after:
                'After checkout you receive (or the operator mints) a one-time unlock code — paste it in the dashboard under Unlock Pro.',
              fallback:
                'Stripe not wired on this host? Email hudson.gouge@projxon.ai with your workspace email to get an unlock code.',
            },
          },
        });
      }

      // ---- Subscribe CTA — redirect to billing host or helpful page; never 404 ----
      if (path === '/subscribe' && request.method === 'GET') {
        const product = url.searchParams.get('product') || 'hookkeep';
        const billing = (env.BILLING_PUBLIC_URL || env.STRIPE_BILLING_URL || '').replace(/\/$/, '');
        if (billing) {
          return Response.redirect(`${billing}/subscribe?product=${encodeURIComponent(product)}`, 302);
        }
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hookkeep Pro — billing not wired</title></head>
<body style="font-family:system-ui;background:#0b1220;color:#e8eefc;max-width:640px;margin:4rem auto;padding:0 1.25rem">
<h1>Stripe Checkout isn't connected on this host yet.</h1>
<p style="color:#9aa8c7">Hookkeep Pro is $9/mo. Set <code>BILLING_PUBLIC_URL</code> on the worker to enable checkout.
Customers can email <a style="color:#3dd6c6" href="mailto:hudson.gouge@projxon.ai">hudson.gouge@projxon.ai</a> for an unlock code.</p>
<p><a style="color:#3dd6c6" href="/">← Back to Hookkeep</a></p></body></html>`,
          { status: 503, headers: { 'content-type': 'text/html' } }
        );
      }

      if (path === '/api/workspace' && request.method === 'POST') {
        const body = await bodyJson();
        const id = 'ws_' + rand(12);
        const ownerToken = 'hk_' + rand(16) + rand(16);
        const ws = {
          id,
          ownerToken,
          email: String(body.email || '').trim().toLowerCase(),
          label: String(body.label || 'My workspace').slice(0, 80),
          tier: 'free',
          unlockedAt: null,
          unlockCode: null,
          eventsThisMonth: 0,
          month: monthKey(),
          createdAt: new Date().toISOString(),
        };
        const inbox = {
          id: rand(12),
          workspaceId: id,
          name: 'Default inbox',
          forwardUrl: '',
          autoForward: false,
          alertKeyword: '',
          alertEmail: ws.email || '',
          notifyWebhookUrl: '',
          createdAt: new Date().toISOString(),
          eventCount: 0,
        };
        const puts = [
          kv.put(`tok:${ownerToken}`, id),
          saveWorkspace(kv, ws),
          kv.put(`ws:${id}:inboxes`, JSON.stringify([inbox.id])),
          kv.put(`inbox:${inbox.id}`, JSON.stringify(inbox)),
        ];
        if (ws.email) puts.push(kv.put(`email:${ws.email}`, id));
        await Promise.all(puts);
        const base = baseUrl(request, env);
        return json({
          workspace: publicWorkspace(ws),
          inbox: publicInbox(inbox),
          ownerToken,
          webhookUrl: `${base}/hook/${inbox.id}`,
          dashboardHint: `Save your owner token. Open /app.html?token=${ownerToken}`,
        });
      }

      if (path === '/api/workspace' && request.method === 'GET') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const ids = await listInboxIds(kv, ws.id);
        const base = baseUrl(request, env);
        const inboxes = [];
        for (const iid of ids) {
          const inbox = await getInbox(kv, iid);
          if (inbox) inboxes.push({ ...publicInbox(inbox), webhookUrl: `${base}/hook/${inbox.id}` });
        }
        return json({ workspace: publicWorkspace(ws), inboxes });
      }

      if (path === '/api/inboxes' && request.method === 'POST') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const body = await bodyJson();
        rolloverMonth(ws);
        const limits = TIERS[ws.tier] || TIERS.free;
        const ids = await listInboxIds(kv, ws.id);
        if (ids.length >= limits.maxInboxes) {
          return json({ error: 'inbox_limit', limit: limits.maxInboxes, upgrade: true }, 402);
        }
        const inbox = {
          id: rand(12),
          workspaceId: ws.id,
          name: String(body.name || `Inbox ${ids.length + 1}`).slice(0, 80),
          forwardUrl: '',
          autoForward: false,
          alertKeyword: '',
          alertEmail: ws.email || '',
          notifyWebhookUrl: '',
          createdAt: new Date().toISOString(),
          eventCount: 0,
        };
        ids.push(inbox.id);
        await Promise.all([
          kv.put(`inbox:${inbox.id}`, JSON.stringify(inbox)),
          kv.put(`ws:${ws.id}:inboxes`, JSON.stringify(ids)),
          saveWorkspace(kv, ws),
        ]);
        return json({ inbox: { ...publicInbox(inbox), webhookUrl: `${baseUrl(request, env)}/hook/${inbox.id}` } });
      }

      const inboxMatch = path.match(/^\/api\/inboxes\/([^/]+)$/);
      if (inboxMatch && request.method === 'PATCH') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const body = await bodyJson();
        const inbox = await getInbox(kv, inboxMatch[1]);
        if (!inbox || inbox.workspaceId !== ws.id) return json({ error: 'not_found' }, 404);
        if (body.name != null) inbox.name = String(body.name).slice(0, 80);
        if (body.forwardUrl != null) inbox.forwardUrl = String(body.forwardUrl).slice(0, 500);
        if (body.autoForward != null) inbox.autoForward = Boolean(body.autoForward);
        if (body.alertKeyword != null) inbox.alertKeyword = String(body.alertKeyword).slice(0, 120);
        if (body.alertEmail != null) inbox.alertEmail = String(body.alertEmail).slice(0, 200);
        if (body.notifyWebhookUrl != null)
          inbox.notifyWebhookUrl = String(body.notifyWebhookUrl).slice(0, 500);
        await kv.put(`inbox:${inbox.id}`, JSON.stringify(inbox));
        return json({ inbox: { ...publicInbox(inbox), webhookUrl: `${baseUrl(request, env)}/hook/${inbox.id}` } });
      }

      const exportMatch = path.match(/^\/api\/inboxes\/([^/]+)\/events\/export$/);
      if (exportMatch && request.method === 'GET') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const inboxId = exportMatch[1];
        const inbox = await getInbox(kv, inboxId);
        if (!inbox || inbox.workspaceId !== ws.id) return json({ error: 'not_found' }, 404);
        const format = String(url.searchParams.get('format') || 'json').toLowerCase();
        if (format !== 'json' && format !== 'csv') {
          return json({ error: 'bad_format', message: 'format must be json or csv' }, 400);
        }
        const limits = TIERS[ws.tier] || TIERS.free;
        const limit = Number(url.searchParams.get('limit') || 50);
        const cap = Math.min(limit || 50, limits.maxEventsKeep);
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const methodFilter = (url.searchParams.get('method') || '').toUpperCase();
        const statusMinRaw = url.searchParams.get('statusMin');
        const statusMin =
          statusMinRaw === null || statusMinRaw === '' ? null : Number(statusMinRaw);
        const raw = await collectFilteredEvents(kv, inboxId, limits, {
          q,
          methodFilter,
          statusMin,
          cap,
        });
        const day = new Date().toISOString().slice(0, 10);
        const filename = `hookkeep-events-${inboxId}-${day}.${format}`;
        if (format === 'csv') {
          return new Response(eventsToCsv(raw), {
            status: 200,
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${filename}"`,
              'access-control-allow-origin': '*',
            },
          });
        }
        const payload = {
          exportedAt: new Date().toISOString(),
          inboxId,
          filters: {
            q: q || undefined,
            method: methodFilter || undefined,
            statusMin: statusMin == null || Number.isNaN(statusMin) ? undefined : statusMin,
            limit,
          },
          events: raw.map(toExportEvent),
        };
        return new Response(JSON.stringify(payload, null, 2) + '\n', {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'access-control-allow-origin': '*',
          },
        });
      }

      const eventsMatch = path.match(/^\/api\/inboxes\/([^/]+)\/events$/);
      if (eventsMatch && request.method === 'GET') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const inboxId = eventsMatch[1];
        const inbox = await getInbox(kv, inboxId);
        if (!inbox || inbox.workspaceId !== ws.id) return json({ error: 'not_found' }, 404);
        const limits = TIERS[ws.tier] || TIERS.free;
        const cap = Math.min(Number(url.searchParams.get('limit') || 50), limits.maxEventsKeep);
        // Mirror Node listEvents filters: q / method / statusMin
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const methodFilter = (url.searchParams.get('method') || '').toUpperCase();
        const statusMinRaw = url.searchParams.get('statusMin');
        const statusMin =
          statusMinRaw === null || statusMinRaw === '' ? null : Number(statusMinRaw);
        const raw = await collectFilteredEvents(kv, inboxId, limits, {
          q,
          methodFilter,
          statusMin,
          cap,
        });
        return json({ events: raw.map(summarizeEvent) });
      }

      const alertsMatch = path.match(/^\/api\/inboxes\/([^/]+)\/alerts$/);
      if (alertsMatch && request.method === 'GET') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const inboxId = alertsMatch[1];
        const inbox = await getInbox(kv, inboxId);
        if (!inbox || inbox.workspaceId !== ws.id) return json({ error: 'not_found' }, 404);
        const cap = Math.min(Number(url.searchParams.get('limit') || 20), 200);
        const listed = await kv.list({ prefix: `alert:${inboxId}:`, limit: cap });
        const alerts = [];
        for (const k of listed.keys) {
          const a = await kv.get(k.name, 'json');
          if (a) alerts.push(a);
        }
        return json({ alerts });
      }

      const eventMatch = path.match(/^\/api\/events\/([^/]+)(\/replay)?$/);
      if (eventMatch) {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const eventId = eventMatch[1];

        // Find the event across the workspace's inboxes
        const findEvent = async () => {
          for (const iid of await listInboxIds(kv, ws.id)) {
            const listed = await kv.list({ prefix: `evt:${iid}:` });
            for (const k of listed.keys) {
              if (k.name.endsWith(`_${eventId.slice(3)}`) || k.name.includes(eventId)) {
                const ev = await kv.get(k.name, 'json');
                if (ev && ev.id === eventId) return { ev, inboxId: iid };
              }
            }
          }
          return null;
        };

        if (!eventMatch[2] && request.method === 'GET') {
          const found = await findEvent();
          if (!found) return json({ error: 'not_found' }, 404);
          return json({ event: found.ev });
        }

        if (eventMatch[2] && request.method === 'POST') {
          const body = await bodyJson();
          const found = await findEvent();
          if (!found) return json({ ok: false, error: 'not_found' }, 404);
          const { ev, inboxId } = found;
          const inbox = await getInbox(kv, inboxId);
          const target = (body.targetUrl || (inbox && inbox.forwardUrl) || '').trim();
          if (!target) return json({ ok: false, error: 'no_forward_url' }, 400);
          let dest;
          try {
            dest = new URL(target);
          } catch {
            return json({ ok: false, error: 'bad_url' }, 400);
          }
          if (!['http:', 'https:'].includes(dest.protocol))
            return json({ ok: false, error: 'bad_protocol' }, 400);

          const headers = { 'content-type': ev.contentType || 'application/json' };
          for (const [k, v] of Object.entries(ev.headers || {})) {
            const lk = k.toLowerCase();
            if (
              ['user-agent', 'x-request-id', 'x-correlation-id', 'stripe-signature', 'x-hub-signature-256'].includes(lk)
            )
              headers[k] = v;
          }
          headers['x-hookkeep-replay'] = '1';
          headers['x-hookkeep-event-id'] = ev.id;

          const started = Date.now();
          try {
            const res = await fetch(target, {
              method: ev.method === 'GET' ? 'POST' : ev.method || 'POST',
              headers,
              body: ev.bodyText || '',
              signal: AbortSignal.timeout(15_000),
            });
            const text = await res.text().catch(() => '');
            return json({
              ok: res.ok,
              status: res.status,
              ms: Date.now() - started,
              bodyPreview: text.slice(0, 2000),
              target,
            });
          } catch (e) {
            return json({ ok: false, error: 'forward_failed', message: String(e.message || e), target }, 400);
          }
        }
      }

      // Billing fulfill bridge (Node parity) — gated by FULFILL_SECRET / HOOKKEEP_FULFILL_SECRET
      if (path === '/api/stripe/fulfill' && request.method === 'POST') {
        const envSecret = env.FULFILL_SECRET || env.HOOKKEEP_FULFILL_SECRET || '';
        const auth = fulfillAuthCheck(envSecret, request.headers.get('x-fulfill-secret') || '');
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = await bodyJson();
        const ws = await getWorkspaceByIdOrEmail(kv, {
          workspaceId: body.workspaceId,
          email: body.email,
        });
        if (!ws) return json({ error: 'workspace_not_found' }, 404);
        let minted = null;
        const resolved = resolveFulfillCode(body, (sessionId) => {
          minted = {
            code: mintUnlockCodeString(sessionId),
            note: `stripe:${String(sessionId).slice(0, 60)}`,
          };
          return minted.code;
        });
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (minted) {
          await kv.put(
            `code:${minted.code}`,
            JSON.stringify({
              tier: 'paid',
              usedBy: null,
              note: minted.note,
              createdAt: new Date().toISOString(),
            })
          );
        }
        try {
          const result = await redeemUnlockOnWorkspace(kv, ws, resolved.code);
          return json({ ok: true, workspace: result.workspace, code: result.key });
        } catch (e) {
          return json({ error: e.code || 'unlock_failed' }, 400);
        }
      }

      if (path === '/api/unlock' && request.method === 'POST') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const body = await bodyJson();
        try {
          const result = await redeemUnlockOnWorkspace(kv, ws, body.code);
          return json({ ok: true, workspace: result.workspace });
        } catch (e) {
          return json({ error: e.code || 'unlock_failed', message: e.code || 'unlock_failed' }, 400);
        }
      }

      if (path === '/api/waitlist' && request.method === 'POST') {
        const body = await bodyJson();
        const em = String(body.email || '').trim().toLowerCase();
        if (!em || !em.includes('@')) return json({ error: 'bad_email' }, 400);
        await kv.put(
          `wait:${em}`,
          JSON.stringify({ email: em, note: String(body.note || '').slice(0, 300), at: new Date().toISOString() })
        );
        return json({ ok: true, message: 'You are on the list. We will email when Pro seats open.' });
      }

      // ---- Static assets (public/) via Workers Static Assets ----
      if (env.ASSETS) {
        if (path === '/') return env.ASSETS.fetch(new URL('/index.html', url).toString(), request);
        return env.ASSETS.fetch(request);
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'internal', message: String(e.message || e) }, 500);
    }
  },
};
