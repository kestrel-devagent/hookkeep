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
    alertKeyword: inbox.alertKeyword || '',
    alertEmail: inbox.alertEmail || '',
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

function baseUrl(request, env) {
  const pub = (env.HOOKKEEP_PUBLIC_URL || '').replace(/\/$/, '');
  if (pub) return pub;
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
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

        // Alert stub (log only — real email needs Mailchannels/SES later)
        let alert = null;
        if (limits.alerts && inbox.alertKeyword) {
          const hay = (event.bodyText || '').toLowerCase();
          const kw = inbox.alertKeyword.toLowerCase();
          if (
            hay.includes(kw) ||
            (event.statusGuess && String(event.statusGuess).toLowerCase().includes(kw))
          ) {
            alert = {
              matched: inbox.alertKeyword,
              to: inbox.alertEmail || ws.email || null,
              note: 'MVP logs alert; email delivery pending',
            };
            console.log('[hookkeep:alert]', JSON.stringify({ inboxId, eventId, ...alert }));
          }
        }

        ctx.waitUntil(
          (async () => {
            await kv.put(evKey(inboxId, ts, eventId), JSON.stringify(event));
            await kv.put(`inbox:${inboxId}`, JSON.stringify(inbox));
            await saveWorkspace(kv, ws);
            // Trim to keep window
            const keys = await kv.list({ prefix: `evt:${inboxId}:` });
            const extra = keys.keys.slice(limits.maxEventsKeep);
            await Promise.all(extra.map((k) => kv.delete(k.name)));
          })()
        );

        return json(
          { ok: true, id: eventId, received: true, alert, overMonth: ws.eventsThisMonth > limits.maxEventsMonth },
          200
        );
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
              method: 'PayPal',
              email: 'hudson.gouge@projxon.ai',
              note: 'Hookkeep Pro $9',
              after:
                'Email the same address with your PayPal transaction ID + workspace email to receive an unlock code.',
            },
          },
        });
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
          alertKeyword: '',
          alertEmail: ws.email || '',
          createdAt: new Date().toISOString(),
          eventCount: 0,
        };
        await Promise.all([
          kv.put(`tok:${ownerToken}`, id),
          saveWorkspace(kv, ws),
          kv.put(`ws:${id}:inboxes`, JSON.stringify([inbox.id])),
          kv.put(`inbox:${inbox.id}`, JSON.stringify(inbox)),
        ]);
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
          alertKeyword: '',
          alertEmail: ws.email || '',
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
        if (body.alertKeyword != null) inbox.alertKeyword = String(body.alertKeyword).slice(0, 120);
        if (body.alertEmail != null) inbox.alertEmail = String(body.alertEmail).slice(0, 200);
        await kv.put(`inbox:${inbox.id}`, JSON.stringify(inbox));
        return json({ inbox: { ...publicInbox(inbox), webhookUrl: `${baseUrl(request, env)}/hook/${inbox.id}` } });
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
        const q = (url.searchParams.get('q') || '').toLowerCase();
        // Keys sort newest-first; scan until we have `cap` matches (bounded by keep window)
        const listed = await kv.list({ prefix: `evt:${inboxId}:`, limit: limits.maxEventsKeep });
        const events = [];
        for (const k of listed.keys) {
          if (events.length >= cap) break;
          const ev = await kv.get(k.name, 'json');
          if (!ev) continue;
          if (
            q &&
            !(ev.bodyText || '').toLowerCase().includes(q) &&
            !(ev.statusGuess || '').toLowerCase().includes(q) &&
            !ev.id.includes(q)
          )
            continue;
          events.push(summarizeEvent(ev));
        }
        return json({ events });
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

      if (path === '/api/unlock' && request.method === 'POST') {
        const ws = await requireWs();
        if (!ws) return json({ error: 'unauthorized' }, 401);
        const body = await bodyJson();
        const key = String(body.code || '').trim().toUpperCase();
        const entry = (await kv.get(`code:${key}`, 'json')) ||
          (BUILTIN_CODES[key] ? { ...BUILTIN_CODES[key] } : null);
        if (!entry) return json({ error: 'invalid_code', message: 'invalid_code' }, 400);
        if (entry.usedBy && entry.usedBy !== ws.id)
          return json({ error: 'code_used', message: 'code_used' }, 400);
        ws.tier = entry.tier || 'paid';
        ws.unlockedAt = new Date().toISOString();
        ws.unlockCode = key;
        entry.usedBy = ws.id;
        entry.usedAt = ws.unlockedAt;
        await Promise.all([saveWorkspace(kv, ws), kv.put(`code:${key}`, JSON.stringify(entry))]);
        return json({ ok: true, workspace: publicWorkspace(ws) });
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
