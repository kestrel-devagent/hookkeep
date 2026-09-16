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

Mount a persistent volume at `HOOKKEEP_DATA` — this also persists `alerts.ndjson` (Pro alert queue). Pro alerts need no extra env or SMTP: users set a Discord/Slack `notifyWebhookUrl` per inbox, and every alert also lands in `alerts.ndjson` + `[hookkeep:alert]` logs.

## 3) Cloudflare Workers + KV (`workers/`)

Code is ready under `workers/` (zero npm deps). Needs a Cloudflare account + KV namespace + `wrangler deploy`. **Not deployed from this box** (no CF token). Free `*.workers.dev` is enough — no paid plan.

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
