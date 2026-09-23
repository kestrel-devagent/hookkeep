# Hookkeep — Cloudflare Workers port

Cloudflare Workers + KV port of the Hookkeep Node MVP (`src/server.js`).
Same product, same API shapes, same `public/` UI — served via Workers Static Assets.
Brand: **Kestrel Ops / Hookkeep**.

## What it does

- Public webhook ingest: `ANY /hook/:inboxId` (and subpaths)
- `POST /api/workspace` — create workspace + first inbox, returns `ownerToken`
- `GET /api/workspace` — workspace + inboxes (token via `x-hookkeep-token`, `?token=`, or Bearer)
- `POST /api/inboxes`, `PATCH /api/inboxes/:id` — create/configure inboxes (forwardUrl, alertKeyword, alertEmail)
- `GET /api/inboxes/:id/events?q=&limit=` — list events (free: last 50, pro: 5000)
- `GET /api/events/:id` — event detail
- `POST /api/events/:id/replay` — forward stored request to `targetUrl` or inbox `forwardUrl`
- `POST /api/unlock` — redeem Pro unlock code (5 inboxes, 5k events/mo, keyword alerts)
- `POST /api/stripe/fulfill` — billing fulfill bridge (Node parity); header `x-fulfill-secret` vs `FULFILL_SECRET` / `HOOKKEEP_FULFILL_SECRET`; body `{ workspaceId? | email?, code? | sessionId? }` mints/redeems unlock and returns `{ ok, workspace, code }`
- `GET /api/inboxes/:id/alerts?limit=` — recent Pro alert records (KV, 30-day TTL)
- `POST /api/waitlist` — Pro waitlist
- `GET /api/pricing`, `GET /api/health`
- `GET /subscribe` — 302 to `BILLING_PUBLIC_URL/subscribe?product=hookkeep` when set, else a helpful 503 page

Pro payment: Stripe Checkout $9/mo via the stripe-billing host (set `BILLING_PUBLIC_URL`); fallback is an operator-minted unlock code via email `hudson.gouge@projxon.ai`.

## Deploy (free workers.dev)

Requires a free Cloudflare account. Node 18+ recommended.

```bash
cd workers
npx wrangler@latest login                      # opens browser, one-time

# Create the KV namespace and paste the ids into wrangler.toml
npx wrangler@latest kv namespace create HOOKKEEP_KV
npx wrangler@latest kv namespace create HOOKKEEP_KV --preview

# Deploy
npx wrangler@latest deploy
```

You get `https://hookkeep.<your-subdomain>.workers.dev` — no npm install needed
(the worker has zero dependencies; wrangler is invoked via npx).

### Deploy via GitHub Actions (optional)

`.github/workflows/deploy-workers.yml` deploys on pushes that touch `workers/`
or `public/` — but only when these repo secrets exist (it no-ops otherwise):

- `CLOUDFLARE_API_TOKEN` — API token with Workers + KV edit perms
- `CLOUDFLARE_ACCOUNT_ID`

You still need to create the KV namespace once and paste the ids into
`wrangler.toml` before the first deploy.

### Seed extra unlock codes (optional)

Built-in codes `HOOKKEEP-PRO-DEMO01` and `HOOKKEEP-PRO-KESTREL` work out of the box.
To add real codes:

```bash
npx wrangler kv key put --binding HOOKKEEP_KV "code:MY-CODE-123" '{"tier":"paid","note":"customer"}'
```

### Local dev

```bash
cd workers
npx wrangler dev        # serves on http://localhost:8787 with local KV
```

## KV layout

| Key | Value |
|---|---|
| `tok:<ownerToken>` | workspace id |
| `ws:<id>` | workspace object |
| `ws:<id>:inboxes` | JSON array of inbox ids |
| `inbox:<id>` | inbox object |
| `evt:<inboxId>:<revTs>_<id>` | event (keys sort newest-first) |
| `wait:<email>` | waitlist entry |
| `email:<email>` | workspace id (fulfill lookup by email) |
| `code:<CODE>` | unlock code entry |
