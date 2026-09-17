# Hookkeep

**Hosted webhook inbox for n8n / automation builders** — by [Kestrel Ops](https://github.com/kestrel-devagent).

Get a durable HTTPS webhook URL, store payloads, search recent events, open details, and replay/forward to your n8n webhook.

## 5-minute local start

1. **Install & start**

   ```bash
   git clone https://github.com/kestrel-devagent/hookkeep && cd hookkeep
   npm install
   npm start          # listens on http://127.0.0.1:8787
   ```

2. **Create a workspace** — open <http://127.0.0.1:8787> → *Create free inbox*
   (or `curl -X POST localhost:8787/api/workspace -d '{}'`). **Copy the owner
   token when prompted — it's your only login.**

3. **Send a webhook** at the URL shown in the dashboard:

   ```bash
   curl -X POST http://127.0.0.1:8787/hook/<inboxId> \
     -H 'content-type: application/json' -d '{"hello":"hookkeep"}'
   ```

4. **Open the dashboard** (`/app.html`) — see the event, headers, raw body.

5. **Replay** — paste your n8n webhook into *Forward URL* in the sidebar, hit
   *Save inbox*, open the event, click **Replay / forward**.

6. (Optional) **Smoke test** the whole path:

   ```bash
   npm test   # create → ingest → list → replay → alerts; prints SMOKE OK
   ```

Data lives in `data/hookkeep.json` (atomic writes). On a host, set
`HOOKKEEP_DATA` to a mounted volume so restarts keep workspaces.

## Marketing site (durable)

**GitHub Pages:** https://kestrel-devagent.github.io/hookkeep/

## Live demo (ephemeral tunnel)

**URL:** https://duo-frost-gonna-surgery.trycloudflare.com

Quick Cloudflare tunnel in front of the Node MVP on the build box. Hostname may change if the tunnel restarts — update `docs/demo.json` when it does. Prefer **HF Space Docker / any Node host / Workers** (see [DEPLOY.md](./DEPLOY.md)).

## Pricing

| Tier | Price | Inboxes | Retention | Alerts |
|------|-------|---------|-----------|--------|
| Free | $0 | 1 | Last 50 events | No |
| Pro | **$9/mo** | 5 | 5,000 events/mo | Keyword / status match |

### How to pay

**Stripe Checkout (preferred):** `/subscribe?product=hookkeep` on a deployed
host redirects to the Kestrel Ops stripe-billing service when
`BILLING_PUBLIC_URL` is set. If billing isn't wired on that host, the page
explains how to get an unlock code by email — it never 404s.

Fallback: email `hudson.gouge@projxon.ai` with your workspace email → receive a
one-time unlock code → paste in dashboard **Unlock Pro**. (Reusable `HOOKKEEP-PRO-*` demo codes exist for testing only — see UNLOCK.md.)

## API sketch

- `POST /api/workspace` → create workspace + first inbox + owner token
- `POST /hook/:inboxId` → **public ingest** (any method)
- `GET /api/workspace` + header `x-hookkeep-token`
- `PATCH /api/inboxes/:id` `{ name?, forwardUrl?, alertKeyword?, alertEmail?, notifyWebhookUrl? }`
- `GET /api/inboxes/:id/events?q=`
- `GET /api/inboxes/:id/alerts?limit=20` → recent Pro alert records
- `GET /api/events/:id`
- `POST /api/events/:id/replay` `{ "targetUrl?: string" }`
- `POST /api/unlock` `{ "code" }`
- `POST /api/waitlist` `{ "email", "note?" }`
- Operator: `npm run digest-waitlist` → mailto draft of waitlist + Stripe unlock path (no SMTP)
- `GET /subscribe` → redirect to billing host (or helpful setup page)
- `GET /api/health` → `dataDir`, `persistOk`, `workspaceCount`, `billing`
- `POST /api/stripe/fulfill` → billing bridge, gated by `HOOKKEEP_FULFILL_SECRET`

### Pro alerts

On Pro workspaces, an ingested event fires an alert when the inbox `alertKeyword`
matches the body/statusGuess **or** an HTTP status ≥ 400 is extracted from the
payload. Delivery: POST to inbox `notifyWebhookUrl` (Discord/Slack-compatible
`{ "content": … }`, ~8s timeout), one line appended to `data/alerts.ndjson`
(+ `[hookkeep:alert]` log), and a `mailtoHint` fallback returned in the alert
record and ingest response. Free tier never fires alerts.

## Deploy notes

See **[DEPLOY.md](./DEPLOY.md)** for free durable paths (HF Space Docker, Node hosts, Cloudflare Workers + optional GH Actions deploy).

- **Node + JSON file store** — zero native deps; works on any free Node host (Render free, Fly free, Railway trial, HF Docker Space, VPS).
- Env: `PORT`, `HOOKKEEP_PUBLIC_URL` (optional; when unset, webhook URLs use the request host — safer than a stale tunnel), `HOOKKEEP_DATA` (persistent volume path — mount it or you lose workspaces on restart), `BILLING_PUBLIC_URL`/`STRIPE_BILLING_URL` (Stripe billing host for `/subscribe`), `HOOKKEEP_FULFILL_SECRET` (billing fulfill bridge).

## Related

- Free offline Catcher: https://kestrel-devagent.github.io/n8n-webhook-catcher/
- Ops Pack (workflows): https://kestrelops.itch.io/n8n-ops-pack-v1

## Brand

Public UI/copy uses **Kestrel Ops / Hookkeep** only. Contact/pay: `hudson.gouge@projxon.ai`.
