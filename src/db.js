/**
 * Hookkeep file-backed store (JSON). Zero native deps — runs on any free Node host.
 * Swap for D1/SQLite later without changing route shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const id16 = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HOOKKEEP_DATA || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'hookkeep.json');

const TIERS = {
  free: { name: 'Free', maxInboxes: 1, maxEventsKeep: 50, maxEventsMonth: 500, alerts: false },
  paid: { name: 'Pro', maxInboxes: 5, maxEventsKeep: 5000, maxEventsMonth: 5000, alerts: true },
};

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    write({
      workspaces: {},
      inboxes: {},
      events: {},
      waitlist: [],
      unlockCodes: {
        'HOOKKEEP-PRO-DEMO01': { tier: 'paid', usedBy: null, note: 'demo' },
        'HOOKKEEP-PRO-KESTREL': { tier: 'paid', usedBy: null, note: 'launch' },
      },
      meta: { createdAt: new Date().toISOString(), version: 1 },
    });
  }
}

function read() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createWorkspace({ email = '', label = '' } = {}) {
  const db = read();
  const id = 'ws_' + nanoid();
  const ownerToken = 'hk_' + id16() + id16();
  const ws = {
    id,
    ownerToken,
    email: String(email || '').trim().toLowerCase(),
    label: String(label || 'My workspace').slice(0, 80),
    tier: 'free',
    unlockedAt: null,
    unlockCode: null,
    eventsThisMonth: 0,
    month: monthKey(),
    createdAt: new Date().toISOString(),
  };
  db.workspaces[id] = ws;
  // Create first inbox
  const inbox = makeInbox(db, ws, { name: 'Default inbox' });
  write(db);
  return { workspace: publicWorkspace(ws), inbox: publicInbox(inbox), ownerToken };
}

function makeInbox(db, ws, { name = 'Inbox' } = {}) {
  const slug = nanoid();
  const inbox = {
    id: slug,
    workspaceId: ws.id,
    name: String(name).slice(0, 80),
    forwardUrl: '',
    alertKeyword: '',
    alertEmail: ws.email || '',
    createdAt: new Date().toISOString(),
    eventCount: 0,
  };
  db.inboxes[slug] = inbox;
  return inbox;
}

export function getWorkspaceByToken(token) {
  if (!token) return null;
  const db = read();
  return Object.values(db.workspaces).find((w) => w.ownerToken === token) || null;
}

export function listInboxes(ws) {
  const db = read();
  return Object.values(db.inboxes).filter((i) => i.workspaceId === ws.id).map(publicInbox);
}

export function createInbox(ws, { name }) {
  const db = read();
  const live = db.workspaces[ws.id];
  if (!live) throw new Error('workspace_not_found');
  rolloverMonth(live);
  const limits = TIERS[live.tier] || TIERS.free;
  const count = Object.values(db.inboxes).filter((i) => i.workspaceId === live.id).length;
  if (count >= limits.maxInboxes) {
    const err = new Error('inbox_limit');
    err.code = 'inbox_limit';
    err.limit = limits.maxInboxes;
    throw err;
  }
  const inbox = makeInbox(db, live, { name: name || `Inbox ${count + 1}` });
  write(db);
  return publicInbox(inbox);
}

export function updateInbox(ws, inboxId, patch) {
  const db = read();
  const inbox = db.inboxes[inboxId];
  if (!inbox || inbox.workspaceId !== ws.id) return null;
  if (patch.name != null) inbox.name = String(patch.name).slice(0, 80);
  if (patch.forwardUrl != null) inbox.forwardUrl = String(patch.forwardUrl).slice(0, 500);
  if (patch.alertKeyword != null) inbox.alertKeyword = String(patch.alertKeyword).slice(0, 120);
  if (patch.alertEmail != null) inbox.alertEmail = String(patch.alertEmail).slice(0, 200);
  write(db);
  return publicInbox(inbox);
}

export function getInbox(inboxId) {
  const db = read();
  return db.inboxes[inboxId] || null;
}

export function ingestEvent(inboxId, { method, headers, bodyText, contentType }) {
  const db = read();
  const inbox = db.inboxes[inboxId];
  if (!inbox) return { ok: false, error: 'not_found' };
  const ws = db.workspaces[inbox.workspaceId];
  if (!ws) return { ok: false, error: 'workspace_missing' };
  rolloverMonth(ws);
  const limits = TIERS[ws.tier] || TIERS.free;

  // Soft monthly cap: still accept but mark over_quota for free after keep window
  const eventId = 'ev_' + id16();
  const receivedAt = new Date().toISOString();
  let parsed = null;
  try {
    if (bodyText && (contentType || '').includes('json')) parsed = JSON.parse(bodyText);
    else if (bodyText && bodyText.trim().startsWith('{')) parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }

  const statusGuess =
    (parsed && (parsed.status || parsed.statusCode || parsed.error || parsed.level)) || null;

  const event = {
    id: eventId,
    inboxId,
    method,
    headers: sanitizeHeaders(headers),
    bodyText: String(bodyText || '').slice(0, 200_000),
    bodyJson: parsed,
    contentType: contentType || '',
    statusGuess: statusGuess != null ? String(statusGuess).slice(0, 80) : null,
    receivedAt,
    size: Buffer.byteLength(bodyText || '', 'utf8'),
  };

  db.events[eventId] = event;
  inbox.eventCount = (inbox.eventCount || 0) + 1;
  ws.eventsThisMonth = (ws.eventsThisMonth || 0) + 1;

  // Trim to keep window (per inbox)
  const keep = limits.maxEventsKeep;
  const inboxEvents = Object.values(db.events)
    .filter((e) => e.inboxId === inboxId)
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  for (const old of inboxEvents.slice(keep)) {
    delete db.events[old.id];
  }

  // Alert stub (log only for MVP — real email needs free SMTP later)
  let alert = null;
  if (limits.alerts && inbox.alertKeyword) {
    const hay = (event.bodyText || '').toLowerCase();
    const kw = inbox.alertKeyword.toLowerCase();
    if (hay.includes(kw) || (event.statusGuess && String(event.statusGuess).toLowerCase().includes(kw))) {
      alert = {
        matched: inbox.alertKeyword,
        to: inbox.alertEmail || ws.email || null,
        note: 'MVP logs alert; email delivery pending SMTP',
      };
      console.log('[hookkeep:alert]', JSON.stringify({ inboxId, eventId, ...alert }));
    }
  }

  write(db);
  return { ok: true, eventId, alert, overMonth: ws.eventsThisMonth > limits.maxEventsMonth };
}

export function listEvents(ws, inboxId, { q = '', limit = 50 } = {}) {
  const db = read();
  const inbox = db.inboxes[inboxId];
  if (!inbox || inbox.workspaceId !== ws.id) return null;
  const limits = TIERS[ws.tier] || TIERS.free;
  let rows = Object.values(db.events)
    .filter((e) => e.inboxId === inboxId)
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  if (q) {
    const qq = q.toLowerCase();
    rows = rows.filter(
      (e) =>
        (e.bodyText || '').toLowerCase().includes(qq) ||
        (e.statusGuess || '').toLowerCase().includes(qq) ||
        e.id.includes(qq)
    );
  }
  const cap = Math.min(limit, limits.maxEventsKeep);
  return rows.slice(0, cap).map(summarizeEvent);
}

export function getEvent(ws, eventId) {
  const db = read();
  const ev = db.events[eventId];
  if (!ev) return null;
  const inbox = db.inboxes[ev.inboxId];
  if (!inbox || inbox.workspaceId !== ws.id) return null;
  return ev;
}

export async function replayEvent(ws, eventId, { targetUrl } = {}) {
  const ev = getEvent(ws, eventId);
  if (!ev) return { ok: false, error: 'not_found' };
  const db = read();
  const inbox = db.inboxes[ev.inboxId];
  const url = (targetUrl || inbox.forwardUrl || '').trim();
  if (!url) return { ok: false, error: 'no_forward_url' };
  let dest;
  try {
    dest = new URL(url);
  } catch {
    return { ok: false, error: 'bad_url' };
  }
  if (!['http:', 'https:'].includes(dest.protocol)) return { ok: false, error: 'bad_protocol' };

  const headers = { 'content-type': ev.contentType || 'application/json' };
  // Forward a safe subset of original headers
  for (const [k, v] of Object.entries(ev.headers || {})) {
    const lk = k.toLowerCase();
    if (['user-agent', 'x-request-id', 'x-correlation-id', 'stripe-signature', 'x-hub-signature-256'].includes(lk)) {
      headers[k] = v;
    }
  }
  headers['x-hookkeep-replay'] = '1';
  headers['x-hookkeep-event-id'] = ev.id;

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: ev.method === 'GET' ? 'POST' : ev.method || 'POST',
      headers,
      body: ev.bodyText || '',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bodyPreview: text.slice(0, 2000),
      target: url,
    };
  } catch (e) {
    return { ok: false, error: 'forward_failed', message: String(e.message || e), target: url };
  }
}

export function addWaitlist({ email, note = '' }) {
  const db = read();
  const em = String(email || '').trim().toLowerCase();
  if (!em || !em.includes('@')) {
    const err = new Error('bad_email');
    err.code = 'bad_email';
    throw err;
  }
  if (!db.waitlist.some((w) => w.email === em)) {
    db.waitlist.push({ email: em, note: String(note).slice(0, 300), at: new Date().toISOString() });
    write(db);
  }
  return { ok: true };
}

export function redeemUnlock(ws, code) {
  const db = read();
  const live = db.workspaces[ws.id];
  if (!live) throw new Error('workspace_not_found');
  const key = String(code || '').trim().toUpperCase();
  const entry = db.unlockCodes[key];
  if (!entry) {
    const err = new Error('invalid_code');
    err.code = 'invalid_code';
    throw err;
  }
  if (entry.usedBy && entry.usedBy !== live.id) {
    const err = new Error('code_used');
    err.code = 'code_used';
    throw err;
  }
  live.tier = entry.tier || 'paid';
  live.unlockedAt = new Date().toISOString();
  live.unlockCode = key;
  entry.usedBy = live.id;
  entry.usedAt = live.unlockedAt;
  write(db);
  return publicWorkspace(live);
}

export function publicWorkspace(ws) {
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
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(lk)) {
      out[k] = '[redacted]';
    } else {
      out[k] = String(v).slice(0, 500);
    }
  }
  return out;
}

function rolloverMonth(ws) {
  const mk = monthKey();
  if (ws.month !== mk) {
    ws.month = mk;
    ws.eventsThisMonth = 0;
  }
}

export { TIERS, DATA_DIR };
