# Hookkeep Pro — manual unlock flow (MVP)

## Customer path (target)

1. Customer creates a free workspace in Hookkeep (saves owner token).
2. Subscribes via **Stripe Checkout — $9/mo** (landing `#stripe` / `/subscribe`).
3. Stripe webhook sets `tier=paid` (when billing stub is live).
4. Fallback (pre-Stripe): operator issues a one-time unlock code (below).
5. Customer opens dashboard → **Unlock Pro** → pastes code if needed.

## Operator path

Codes live in `data/hookkeep.json` → `unlockCodes`.

Seed codes shipped with MVP:

- `HOOKKEEP-PRO-DEMO01` — **reusable demo** (note contains `demo`; does not burn)
- `HOOKKEEP-PRO-KESTREL` — one-time launch code

To mint a new code (server offline or via shell):

```bash
node -e "
import fs from 'fs';
const p='data/hookkeep.json';
const db=JSON.parse(fs.readFileSync(p,'utf8'));
const code='HOOKKEEP-PRO-'+Math.random().toString(36).slice(2,8).toUpperCase();
db.unlockCodes[code]={tier:'paid',usedBy:null,note:'stripe-or-manual',createdAt:new Date().toISOString()};
fs.writeFileSync(p,JSON.stringify(db,null,2));
console.log(code);
"
```

After redeem, `usedBy` is set to workspace id — code cannot be reused.

## Pro alerts (shipped)

Once `tier=paid`, alerts fire on ingested events when **either**:

- inbox `alertKeyword` matches the body/statusGuess (case-insensitive), **or**
- an HTTP-ish status ≥ 400 is found in the payload (`status`/`statusCode`/`httpStatus`/`code` fields, `statusGuess`, or `"status":500`-style body text).

Delivery (no SMTP required):

1. **Notify webhook** — if inbox `notifyWebhookUrl` is set (https, or localhost for dev), Hookkeep POSTs a Discord/Slack-compatible `{ "content": "…" }` JSON body (~8s timeout, failures never break ingest).
2. **`data/alerts.ndjson`** — every alert appended as one NDJSON line + `[hookkeep:alert]` console log (greppable ops queue).
3. **Mailto hint** — the alert record and ingest API response include a `mailtoHint` (to `alertEmail` → workspace email → pay contact) with prefilled subject/body.

Free workspaces get **no** alerts even if the fields are set.

## What's left for real subscriptions

1. Stripe Checkout webhook → auto-set `tier=paid` (see `/workspace/ship/stripe-billing-2026-09-16/`)
2. Recurring billing + grace period on cancel
3. Optional SMTP email delivery (Resend/Mailgun free tier) — webhook + mailto covers MVP
4. Durable multi-region store (Cloudflare D1 / Turso)
5. Auth (magic link) so owner token isn't the only login
