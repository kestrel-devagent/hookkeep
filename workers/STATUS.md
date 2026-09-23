# Workers port — STATUS

**Author:** Devin SWE-2 medium (+ orchestrator finish)
**Updated:** 2026-09-23

## What works (code complete; deploy needs CF account)

- `workers/src/worker.js` — full API mirror of Node MVP on Workers + KV
  - incl. `GET /subscribe` (redirects to `BILLING_PUBLIC_URL` when set, else a
    helpful 503 page — never 404) and `GET /api/inboxes/:id/alerts` (KV-backed
    alert records, 30-day TTL)
- `wrangler.toml` — assets from `../public`, KV binding placeholders
- `.github/workflows/deploy-workers.yml` — deploys on push when
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets exist;
  no-ops cleanly without them (free `*.workers.dev` — no paid plan needed)
- README with `wrangler login` / `kv namespace create` / `deploy` steps
- Built-in unlock codes DEMO01 + KESTREL
- Zero npm deps in the worker itself

## Deploy status

**Not deployed to workers.dev** — no Cloudflare account/API token on the box.
Canonical live demo remains the Node + trycloudflare tunnel.

## Gaps vs Node MVP

| Area | Node | Workers |
|------|------|---------|
| Storage | JSON file (atomic tmp+rename) | KV (needs namespace id) |
| Alerts | `data/alerts.ndjson` + console log | KV `alert:` keys (30d TTL) + console log |
| Billing fulfill bridge | `POST /api/stripe/fulfill` | ported 2026-09-23 (`FULFILL_SECRET` / `HOOKKEEP_FULFILL_SECRET` + `x-fulfill-secret`) |
| Static UI | `@hono/node-server` static | Workers Assets |
| Event filters (`q`/`method`/`statusMin`) | Node `listEvents` | Workers KV list path (parity 2026-09-22) |
| Local smoke | `npm test` | needs `wrangler dev` |

## Done recently

- 2026-09-23: ported Node `POST /api/stripe/fulfill` into Workers (auth gate, mint-from-sessionId, redeem, email index `email:<em>`). Unit: `scripts/workers-fulfill-unit.js`.
- 2026-09-22: mirrored inbound event filters (`q` / `method` / `statusMin`) into Workers `GET /api/inboxes/:id/events` to match Node `listEvents`.

## Next

1. Hudson (or agent with CF login): create KV + `wrangler deploy`
   (or set `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets and let
   the workflow deploy on the next push — KV ids still need to be pasted into
   `wrangler.toml` first)
2. Point marketing / README live URL at `*.workers.dev`
3. Optionally delete ephemeral tunnel once Workers is green

## Exact CF deploy blocker (2026-09-16)

```
$ wrangler whoami
You are not authenticated. Please run `wrangler login`.
```

- No `CLOUDFLARE_API_TOKEN` / account id on this box
- `workers/wrangler.toml` still has `REPLACE_WITH_KV_NAMESPACE_ID` placeholders
- GH Actions workflow mirror: `docs/ci/deploy-workers.yml` (could not push `.github/workflows/` — PAT lacks `workflow` scope)
- Free path once unblocked: `wrangler login` → `wrangler kv namespace create HOOKKEEP_KV` → paste ids → `wrangler deploy` → `*.workers.dev`

