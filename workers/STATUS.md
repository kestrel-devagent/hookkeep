# Workers port — STATUS

**Author:** Devin SWE-2 medium (+ orchestrator finish)
**Updated:** 2026-10-07

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
| Bulk events export JSON/CSV | Node `/events/export` | Workers same route (parity 2026-09-25) |
| Bulk replay filtered | Node `/events/replay-bulk` | Workers same route (parity 2026-10-02) |
| Bulk delete filtered | Node `/events/delete-bulk` | Workers same route — KV delete + `eventCount` decrement (parity 2026-10-05) |
| Custom ingest response | Node `/hook/:inboxId` honors inbox `responseStatus`/`responseBody`/`responseContentType` | Workers same — shared `src/custom-response.js` (bundled by wrangler); unit drives `worker.fetch` with a KV mock (parity 2026-10-06) |
| Signature check | Node `/hook/:inboxId` verifies inbox `signingScheme` (stripe/github/hmac-sha256) over raw bytes → event `signature` | Workers same — shared `src/signature.js` (WebCrypto, zero deps, bundled by wrangler); unit drives `worker.fetch` with a KV mock (parity 2026-10-07) |
| Local smoke | `npm test` | needs `wrangler dev` |

## Done recently

- 2026-10-07: per-inbox webhook signature verification — inbox `signingScheme` (`none`/`stripe`/`github`/`hmac-sha256`) + write-only `signingSecret` (≤500; APIs return only `hasSigningSecret` + masked `signingSecretHint`) + `signingHeader` (hmac, default `x-signature`); `/hook/:inboxId` verifies the raw body bytes (Stripe `t.body` with multi-`v1` + 300s tolerance → `timestampSkewSec`; GitHub `sha256=`; generic hex/`sha256=` hex), constant-time compare; event `signature: { scheme, valid, reason }`; capture + ingest response unchanged; list/export include it (CSV `signatureValid,signatureReason`), `?sig=valid|invalid|unchecked` filter; bad scheme → 400 `bad_signing_scheme`; dashboard **Signature check** panel + `✓ sig`/`✗ sig` badges; unit `signature-unit.js` (helper + Workers fetch path).
- 2026-10-06: custom ingest response — inbox `responseStatus` (200–599, 0 = default ack) + `responseBody` (templated `{{eventId}}`/`{{method}}`/`{{receivedAt}}`/`{{json.path}}`) + `responseContentType`; `/hook/:inboxId` answers with it (204/205/304 bodiless) + `x-hookkeep-event-id`; events record `respondedStatus`/`respondedCustom`; bad status → 400 `bad_response_status`; dashboard **Custom response** panel with presets; unit `custom-response-unit.js` (helper + Workers fetch path).
- 2026-10-05: bulk delete of filtered events — `POST /api/inboxes/:id/events/delete-bulk` (same filters; hard max 50; requires `confirm: true` else 400 `confirm_required`; decrements inbox `eventCount`, floor 0); dashboard **Delete filtered** with confirm dialog; unit `workers-delete-bulk-unit.js`.
- 2026-10-02: bulk replay of filtered events — `POST /api/inboxes/:id/events/replay-bulk` (same filters; hard max 50; serial via existing forward path); dashboard **Replay filtered**; unit `workers-replay-bulk-unit.js`.
- 2026-09-25: bulk filtered events export — `GET /api/inboxes/:id/events/export?format=json|csv` (same q/method/statusMin + list cap); dashboard Export JSON/CSV; unit `workers-export-unit.js`.
- 2026-09-24: auto-forward on ingest parity — inbox `autoForward` boolean + `forwardUrl`; after store, POST capture to forwardUrl (~8s) and persist `event.autoForward` (Node sync + Workers `waitUntil`). Free tier allowed.
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

