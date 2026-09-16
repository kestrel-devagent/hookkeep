# Hookkeep — free durable deploy paths

No paid Cloudflare plan required. Prefer these over the ephemeral `trycloudflare` demo tunnel.

## 1) Hugging Face Docker Space (recommended free path)

Files already in-repo:

- `Dockerfile` — Node 20 Alpine, listens on `7860`, data at `/data`
- `README_SPACE.md` — Space frontmatter (`sdk: docker`, `app_port: 7860`)

Steps (HF account free):

```bash
# from repo root — rename README_SPACE.md content into Space README, or:
# create Space → Docker → upload this repo

# On the Space, set:
#   HOOKKEEP_PUBLIC_URL=https://<user>-hookkeep.hf.space
#   HOOKKEEP_DATA=/data
# Attach a persistent volume to /data if available on your tier.
```

Create Space UI: https://huggingface.co/new-space → SDK **Docker** → push this repo (or `huggingface-cli upload`).

After deploy, webhook URLs become `https://<space>/hook/<inboxId>`.

## 2) Any free Node host (Render / Railway / Fly / VPS)

```bash
npm install --omit=dev
PORT=8787 HOOKKEEP_PUBLIC_URL=https://YOUR_HOST HOOKKEEP_DATA=/var/data npm start
```

**Mount a persistent volume at `HOOKKEEP_DATA`** — without it every restart wipes
workspaces, tokens, events, and `alerts.ndjson` (the Pro alert queue). Pro alerts
need no extra env or SMTP: users set a Discord/Slack `notifyWebhookUrl` per inbox,
and every alert also lands in `alerts.ndjson` + `[hookkeep:alert]` logs.

Optional env:

- `HOOKKEEP_PUBLIC_URL` — public base for webhook URLs. **When unset the server
  uses the request Host**, which is safer than pointing at a stale
  `*.trycloudflare.com` tunnel.
- `BILLING_PUBLIC_URL` (or `STRIPE_BILLING_URL`) — base URL of the
  stripe-billing host. Makes `/subscribe?product=hookkeep` 302 into Stripe
  Checkout. When unset, `/subscribe` returns a helpful page (never a 404).
- `HOOKKEEP_FULFILL_SECRET` — enables `POST /api/stripe/fulfill`
  (`x-fulfill-secret` header) so the billing app can auto-unlock a workspace
  after `checkout.session.completed`: body `{ workspaceId | email, code? | sessionId? }`.
  With only a `sessionId`, Hookkeep mints and redeems a fresh one-time code.

## 3) Cloudflare Workers + KV (`workers/`)

Code is ready under `workers/` (zero npm deps). Needs a Cloudflare account + KV namespace + `wrangler deploy`. **Not deployed from this box** (no CF token). Free `*.workers.dev` is enough — no paid plan.

CI path: `.github/workflows/deploy-workers.yml` deploys on push when
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets exist — it no-ops
without them. KV namespace ids still must be pasted into `workers/wrangler.toml`
once.

See `workers/README.md` and `workers/STATUS.md`.

## 4) GitHub Pages marketing (durable URL)

`docs/` is the static marketing site. Enable Pages: Settings → Pages → Deploy from branch `main` / folder `/docs`.

- Site: `https://kestrel-devagent.github.io/hookkeep/`
- Point the CTA at the current demo via `docs/demo.json` (`demoUrl`).

This is marketing-only (no ingest API). Host the Node app separately.

## 5) Local + quick tunnel (current demo)

```bash
npm start   # :8787
cloudflared tunnel --url http://127.0.0.1:8787
```

Hostname rotates when the tunnel process restarts. Fine for smoke demos only.

## Smoke test

```bash
npm test   # server must already be running
curl -s "$HOOKKEEP_PUBLIC_URL/api/health"
```

## CI workflow note

GitHub Actions workflow source of truth for Agents without `workflow` PAT scope: `docs/ci/deploy-workers.yml`.
Copy to `.github/workflows/deploy-workers.yml` once a token with `workflow` scope can push it.
