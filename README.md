# Hookkeep

**Hosted webhook inbox for n8n / automation builders** — by [Kestrel Ops](https://github.com/kestrel-devagent).

Get a durable HTTPS webhook URL, store payloads, search recent events, open details, and replay/forward to your n8n webhook.

## Pricing (MVP)

| Tier | Price | Inboxes | Retention | Alerts |
|------|-------|---------|-----------|--------|
| Free | $0 | 1 | Last 50 events | No |
| Pro | **$9/mo** | 5 | 5,000 events/mo | Keyword / status match |

### How to pay

1. PayPal **$9 USD** to `hudson.gouge@projxon.ai` with note `Hookkeep Pro $9`
2. Email the same address with PayPal txn ID + your Hookkeep workspace email
3. Receive a one-time unlock code → paste in dashboard **Unlock Pro**

Manual unlock is intentional for MVP (no Stripe yet).

## Quick start (local)

```bash
cd hookkeep-2026-09-15
npm install
npm start
# open http://127.0.0.1:8787
```

```bash
# smoke test (server must be running)
npm test
```

## API sketch

- `POST /api/workspace` → create workspace + first inbox + owner token
- `POST /hook/:inboxId` → **public ingest** (any method)
- `GET /api/workspace` + header `x-hookkeep-token`
- `GET /api/inboxes/:id/events?q=`
- `GET /api/events/:id`
- `POST /api/events/:id/replay` `{ "targetUrl?: string" }`
- `POST /api/unlock` `{ "code" }`
- `POST /api/waitlist` `{ "email", "note?" }`

## Deploy notes

- **Node + JSON file store** — zero native deps; works on any free Node host (Render free, Fly free, Railway trial, HF Docker Space, VPS).
- Set `PORT` and optional `HOOKKEEP_PUBLIC_URL` (public base URL for webhook links).
- Set `HOOKKEEP_DATA` to a persistent volume path when available.
- Cloudflare Workers + D1 port is a natural next step for global ingest.

## Related

- Free offline Catcher: https://kestrel-devagent.github.io/n8n-webhook-catcher/
- Ops Pack (workflows): https://kestrelops.itch.io/n8n-ops-pack-v1

## Brand

Public UI/copy uses **Kestrel Ops / Hookkeep** only. Contact/pay: `hudson.gouge@projxon.ai`.
