# Workers port — STATUS

**Author:** Devin SWE-2 medium (+ orchestrator finish)  
**Date:** 2026-09-15

## What works (code complete; deploy needs CF account)

- `workers/src/worker.js` — full API mirror of Node MVP on Workers + KV
- `wrangler.toml` — assets from `../public`, KV binding placeholders
- README with `wrangler login` / `kv namespace create` / `deploy` steps
- Built-in unlock codes DEMO01 + KESTREL
- Zero npm deps in the worker itself

## Deploy status

**Not deployed to workers.dev this run** — no Cloudflare account/API token on the box.
Canonical live demo remains the Node + trycloudflare tunnel.

## Gaps vs Node MVP

| Area | Node | Workers |
|------|------|---------|
| Storage | JSON file | KV (needs namespace id) |
| Alerts | console log | console log (same stub) |
| Static UI | `@hono/node-server` static | Workers Assets |
| Local smoke | `npm test` | needs `wrangler dev` (exec blocked in Devin print mode once) |

## Next

1. Hudson (or agent with CF login): create KV + `wrangler deploy`
2. Point marketing / README live URL at `*.workers.dev`
3. Optionally delete ephemeral tunnel once Workers is green
