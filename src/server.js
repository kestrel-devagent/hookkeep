/**
 * Hookkeep — hosted webhook inbox (Kestrel Ops)
 * Free-tier Node server. Public ingest + owner dashboard.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE = (process.env.HOOKKEEP_PUBLIC_URL || '').replace(/\/$/, '');
const BILLING_PUBLIC_URL = (
  process.env.BILLING_PUBLIC_URL ||
  process.env.STRIPE_BILLING_URL ||
  ''
).replace(/\/$/, '');
const FULFILL_SECRET = process.env.HOOKKEEP_FULFILL_SECRET || '';

const app = new Hono();
app.use('*', cors());

function ownerToken(c) {
  return (
    c.req.header('x-hookkeep-token') ||
    c.req.query('token') ||
    (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '') ||
    ''
  );
}

function requireWs(c) {
  const ws = db.getWorkspaceByToken(ownerToken(c));
  if (!ws) return null;
  return ws;
}

function baseUrl(c) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || `localhost:${PORT}`;
  const proto = c.req.header('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'hookkeep',
    brand: 'Kestrel Ops',
    ts: new Date().toISOString(),
    ...db.persistStatus(),
    billing: BILLING_PUBLIC_URL || null,
  })
);

app.get('/api/pricing', (c) =>
  c.json({
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
        billingHost: BILLING_PUBLIC_URL || null,
        note: 'Hookkeep Pro $9/mo via Stripe Checkout',
        after:
          'After checkout you receive (or the operator mints) a one-time unlock code — paste it in the dashboard under Unlock Pro.',
        fallback:
          'Stripe not wired on this host? Email hudson.gouge@projxon.ai with your workspace email to get an unlock code.',
      },
    },
  })
);

/** Subscribe CTA — redirect to the stripe-billing host when configured; never 404. */
app.get('/subscribe', (c) => {
  const product = c.req.query('product') || 'hookkeep';
  if (BILLING_PUBLIC_URL) {
    return c.redirect(`${BILLING_PUBLIC_URL}/subscribe?product=${encodeURIComponent(product)}`, 302);
  }
  return c.html(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hookkeep Pro — billing not wired</title>
<link rel="stylesheet" href="/styles.css"></head><body>
<main class="wrap" style="max-width:640px;margin:4rem auto;padding:0 1.25rem">
  <h1>Stripe Checkout isn't connected on this host yet.</h1>
  <p class="muted">Hookkeep Pro is $9/mo. This deployment has no <code>BILLING_PUBLIC_URL</code> set,
  so checkout can't start here.</p>
  <ul class="muted">
    <li>Operator: set <code>BILLING_PUBLIC_URL</code> to the stripe-billing host (see <code>DEPLOY.md</code>).</li>
    <li>Customer: email <a href="mailto:hudson.gouge@projxon.ai">hudson.gouge@projxon.ai</a> with your workspace email to get a Pro unlock code.</li>
  </ul>
  <p><a class="btn" href="/">← Back to Hookkeep</a> <a class="btn" href="/app.html">Open dashboard</a></p>
</main></body></html>`,
    503
  );
});

/**
 * Billing fulfill bridge (for the stripe-billing app to call after checkout).
 * Gated by HOOKKEEP_FULFILL_SECRET. Body: { workspaceId? | email?, code? | sessionId? }
 * - With `code`: redeems that code on the workspace.
 * - With `sessionId` only: mints a fresh one-time code, redeems it, returns it.
 */
app.post('/api/stripe/fulfill', async (c) => {
  if (!FULFILL_SECRET) return c.json({ error: 'fulfill_not_configured' }, 503);
  const secret = c.req.header('x-fulfill-secret') || '';
  if (secret !== FULFILL_SECRET) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const ws = db.getWorkspaceByIdOrEmail({ workspaceId: body.workspaceId, email: body.email });
  if (!ws) return c.json({ error: 'workspace_not_found' }, 404);
  let code = String(body.code || '').trim();
  if (!code && body.sessionId) {
    code = db.mintUnlockCode({ note: `stripe:${String(body.sessionId).slice(0, 60)}` });
  }
  if (!code) return c.json({ error: 'need_code_or_session' }, 400);
  try {
    const workspace = db.redeemUnlock(ws, code);
    return c.json({ ok: true, workspace, code });
  } catch (e) {
    return c.json({ error: e.code || 'unlock_failed' }, 400);
  }
});

/** Create workspace + first inbox */
app.post('/api/workspace', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const created = db.createWorkspace({ email: body.email, label: body.label });
  const base = baseUrl(c);
  return c.json({
    ...created,
    webhookUrl: `${base}/hook/${created.inbox.id}`,
    dashboardHint: `Save your owner token. Open /app.html?token=${created.ownerToken}`,
  });
});

app.get('/api/workspace', (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const inboxes = db.listInboxes(ws).map((inbox) => ({
    ...inbox,
    webhookUrl: `${baseUrl(c)}/hook/${inbox.id}`,
  }));
  return c.json({ workspace: db.publicWorkspace(ws), inboxes });
});

app.post('/api/inboxes', async (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  try {
    const inbox = db.createInbox(ws, { name: body.name });
    return c.json({ inbox: { ...inbox, webhookUrl: `${baseUrl(c)}/hook/${inbox.id}` } });
  } catch (e) {
    if (e.code === 'inbox_limit') {
      return c.json({ error: 'inbox_limit', limit: e.limit, upgrade: true }, 402);
    }
    throw e;
  }
});

app.patch('/api/inboxes/:id', async (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const inbox = db.updateInbox(ws, c.req.param('id'), body);
  if (!inbox) return c.json({ error: 'not_found' }, 404);
  return c.json({ inbox: { ...inbox, webhookUrl: `${baseUrl(c)}/hook/${inbox.id}` } });
});

app.get('/api/inboxes/:id/events', (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const q = c.req.query('q') || '';
  const method = c.req.query('method') || '';
  const statusMinRaw = c.req.query('statusMin');
  const statusMin =
    statusMinRaw === undefined || statusMinRaw === '' ? null : Number(statusMinRaw);
  const events = db.listEvents(ws, c.req.param('id'), {
    q,
    method,
    statusMin,
    limit: Number(c.req.query('limit') || 50),
  });
  if (!events) return c.json({ error: 'not_found' }, 404);
  return c.json({ events });
});

app.get('/api/inboxes/:id/alerts', (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const alerts = db.listAlerts(ws, c.req.param('id'), {
    limit: Number(c.req.query('limit') || 20),
  });
  if (!alerts) return c.json({ error: 'not_found' }, 404);
  return c.json({ alerts });
});

app.get('/api/events/:id', (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const ev = db.getEvent(ws, c.req.param('id'));
  if (!ev) return c.json({ error: 'not_found' }, 404);
  return c.json({ event: ev });
});

app.post('/api/events/:id/replay', async (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const result = await db.replayEvent(ws, c.req.param('id'), { targetUrl: body.targetUrl });
  const status = result.ok ? 200 : result.error === 'not_found' ? 404 : 400;
  return c.json(result, status);
});

app.post('/api/unlock', async (c) => {
  const ws = requireWs(c);
  if (!ws) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  try {
    const workspace = db.redeemUnlock(ws, body.code);
    return c.json({ ok: true, workspace });
  } catch (e) {
    return c.json({ error: e.code || 'unlock_failed', message: e.message }, 400);
  }
});

app.post('/api/waitlist', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = db.addWaitlist({ email: body.email, note: body.note });
    const note = String(body.note || '').slice(0, 200);
    const subject = encodeURIComponent('Hookkeep waitlist');
    const mailBody = encodeURIComponent(
      `New waitlist signup\nEmail: ${String(body.email || '').trim()}\nNote: ${note}\n`
    );
    return c.json({
      ok: true,
      isNew: result.isNew,
      message: result.isNew
        ? 'You are on the list. Optional: open the mailto to ping Kestrel Ops.'
        : 'You were already on the list — still recorded.',
      notifyMailto: `mailto:hudson.gouge@projxon.ai?subject=${subject}&body=${mailBody}`,
    });
  } catch {
    return c.json({ error: 'bad_email' }, 400);
  }
});

/** Public webhook ingest — any method */
async function ingest(c) {
  const inboxId = c.req.param('inboxId');
  if (!db.getInbox(inboxId)) {
    return c.json({ ok: false, error: 'unknown_inbox' }, 404);
  }
  const bodyText = await c.req.text();
  const headers = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const result = db.ingestEvent(inboxId, {
    method: c.req.method,
    headers,
    bodyText,
    contentType: c.req.header('content-type') || '',
  });
  if (!result.ok) return c.json(result, 404);
  const resp = { ok: true, id: result.eventId, received: true };
  if (result.alert) {
    const a = result.alert;
    resp.alert = {
      matched: true,
      reason: a.reason,
      matchedValue: a.matchedValue,
      queued: true,
      mailtoHint: a.mailtoHint,
    };
    if (a.notifyWebhookUrl) {
      resp.alert.webhookAttempted = true;
      const wh = await db.sendNotifyWebhook(a.notifyWebhookUrl, a);
      resp.alert.webhookOk = wh.ok;
      if (wh.status != null) resp.alert.webhookStatus = wh.status;
      if (wh.error) resp.alert.webhookError = wh.error;
    }
  }
  return c.json(resp, 200);
}

app.all('/hook/:inboxId', ingest);
app.all('/hook/:inboxId/*', ingest);

app.use('/*', serveStatic({ root: path.join(ROOT, 'public') }));
app.get('/', (c) => c.redirect('/index.html'));

console.log(`[hookkeep] listening on http://0.0.0.0:${PORT}`);
console.log(`[hookkeep] data dir: ${db.DATA_DIR}`);
console.log(
  `[hookkeep] billing: ${BILLING_PUBLIC_URL || 'NOT SET — /subscribe shows setup page'}${PUBLIC_BASE ? ` · public URL: ${PUBLIC_BASE}` : ' · public URL: request host (HOOKKEEP_PUBLIC_URL unset)'}`
);
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
