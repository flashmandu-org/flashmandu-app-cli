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

## App Embed Blocks (storefront surface)

- `app/embed/[type]/page.tsx` — reference storefront embed block. The platform
  loads this route inside a sandboxed `<iframe sandbox="allow-scripts">` on the
  merchant storefront, passing a per-view, one-time signed token:

  ```
  /embed/<block_type>?session_token=<token>&instance_id=<node-id>&...
  ```

  The token shape (matches the local `EmbedBlockTester`) is `<body>.<sig>`,
  where `body = base64url(json(payload))` and
  `sig  = base64url(hmac_sha256(body + sorted_query, FLASHMANDU_APP_SECRET))`.
  `sorted_query` is the query rebuilt with keys in ascending order,
  RFC3986-encoded; verification is constant-time. The page verifies the token
  as defense-in-depth, then connects to the storefront App Bridge
  (`createAppBridge()`) for identity / resize / navigate / error capabilities.

  Only the capabilities the block declared AND that are in the platform
  allowlist (`[identity, resize, navigate, error]`) are granted — never merchant
  scopes, never `profile_id` (a pseudonymous `visitor_id` only). See the host
  partner doc `docs/app-platform/embed-blocks.md` for the full contract.
