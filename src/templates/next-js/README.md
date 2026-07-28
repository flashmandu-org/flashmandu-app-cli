# Flashmandu App — Next.js

A Next.js (App Router, TypeScript) starter for a Flashmandu storefront app.
Wires the OAuth + webhook contracts the Flashmandu platform expects.

## What's included

- `app/oauth/authorize/route.ts` — OAuth Authorize endpoint. The platform
  redirects the merchant here with standard OAuth + PKCE (S256) params; this
  route returns the merchant to the platform's callback with a `code` + the
  original `state`.
- `app/oauth/token/route.ts` — OAuth Token + credential-delivery endpoint.
  Receives two POSTs from the platform: the PKCE code exchange, then the
  credential delivery (`{api_token, webhook_secret, ...}` signed with HMAC).
  Stores credentials in `.flashmandu/install.<app_id>.json` (gitignored).
- `app/oauth/callback/route.ts` — developer convenience landing page. Not in
  the host's OAuth contract.
- `app/webhooks/flashmandu/route.ts` — webhook receiver. Verifies
  `X-App-Signature` over `${X-App-Timestamp}.${rawBody}` keyed by
  `FLASHMANDU_WEBHOOK_SECRET`, then dispatches the event.
- `lib/hmac.ts` — constant-time HMAC verifier with timestamp-skew replay
  defence.
- `lib/config.ts` / `lib/flashmandu.ts` — env loader + minimal API client for
  `GET /api/apps/me` and `GET /api/apps/hooks`.

## Local dev

```bash
npm install
flashmandu-app dev
```

`flashmandu-app dev` opens a public tunnel, registers the sandbox with the
dev-box, and writes `.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored).
Wire those into env (e.g. via `dotenv`):

```bash
set -a; source <(jq -r 'to_entries[]|"\(.key|ascii_upcase)=\(.value|@sh)"' \
  .flashmandu/sandbox-secrets.*.json); set +a
npm run dev
```

## OAuth + webhook contract

See `flashmandu.app.toml` for the URL wiring. The platform:

1. Begins install → merchant lands on `/oauth/authorize`.
2. App returns merchant to platform callback with `code` + `state`.
3. Platform POSTs the code exchange to `/oauth/token` (`code_verifier` in hand).
4. Platform POSTs credentials to `/oauth/token` — app stores them.

Subsequent events fire signed POSTs to `/webhooks/flashmandu`.
