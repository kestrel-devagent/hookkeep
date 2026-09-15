# Hookkeep Pro — manual unlock flow (MVP)

## Customer path

1. Customer creates a free workspace in Hookkeep (saves owner token).
2. Pays **$9 USD** via PayPal to `hudson.gouge@projxon.ai` (note: `Hookkeep Pro $9`).
3. Emails `hudson.gouge@projxon.ai` with:
   - PayPal transaction ID
   - Workspace email (if set) **or** last 8 chars of owner token
4. Operator replies with a one-time code (see below).
5. Customer opens dashboard → **Unlock Pro** → pastes code.

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
db.unlockCodes[code]={tier:'paid',usedBy:null,note:'paypal-manual',createdAt:new Date().toISOString()};
fs.writeFileSync(p,JSON.stringify(db,null,2));
console.log(code);
"
```

After redeem, `usedBy` is set to workspace id — code cannot be reused.

## What's left for real subscriptions

1. Stripe Checkout (or PayPal Subscriptions) webhook → auto-set `tier=paid`
2. Recurring billing + grace period on cancel
3. Real email alerts (Resend/Mailgun free tier or SMTP)
4. Durable multi-region store (Cloudflare D1 / Turso)
5. Auth (magic link) so owner token isn't the only login
