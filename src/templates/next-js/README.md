# AutoHisab Business App — Next.js

A Next.js (App Router, TypeScript) starter for an AutoHisab Business app.
Wires the OAuth + webhook contracts the platform expects, and renders through
the host's own chrome so the embed is indistinguishable from a native page.

## Page chrome — read this first

**Do not render a desktop page heading.** Breadcrumbs, page actions and the
dirty ⇄ Save/Discard swap live in the HOST command bar; the app declares them
with `usePageChrome` and the host draws them. An in-page title bar is exactly
what makes an embed look bolted-on.

`lib/chrome.tsx` wraps that in one component:

```tsx
<AppPage
  title="Items"
  crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Items' }]}
  actions={[{ id: 'new', label: 'New item', variant: 'primary', onSelect: create }]}
  dirty={form.isDirty}
>
  …
</AppPage>
```

Below `lg`, where the host command bar is not visible, `AppPage` renders
`MobilePageHeader` inside the iframe. It is `lg:hidden` in CSS, so the two
never both appear and there is no hydration flash.

## What's included

- `lib/chrome.tsx` — `AppPage`: the one place page chrome is declared.
- `app/page.tsx` — dashboard. No heading; chrome comes from the host.
- `app/items/page.tsx` — the standard list surface: `IndexTable` with sortable
  columns, a pinned first column, selection + bulk actions, pagination in the
  shell footer, and **skeleton-first loading** (placeholder rows, never a blank
  pane and never a layout jump).
- `app/(admin)/settings/page.tsx` — dirty-state example: while the form is
  dirty the host swaps its bar for native Save / Discard, which still call back
  into this page by action id.
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
- `lib/revalidate.ts` — `purgePlatformEmbedCaches()`: call after any mutation
  to data your embed blocks render or list as options, so the platform drops
  the cached picker markup + dynamic-options payloads immediately instead of
  waiting out the TTL.

## Local dev

```bash
npm install
autohisab-business dev
```

`autohisab-business dev` opens a public tunnel, registers the sandbox with the
dev-box, and writes `.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored).
Wire those into env (e.g. via `dotenv`):

```bash
set -a; source <(jq -r 'to_entries[]|"\(.key|ascii_upcase)=\(.value|@sh)"' \
  .flashmandu/sandbox-secrets.*.json); set +a
npm run dev
```

## Platform deploys (migrations + seeding)

The bundled `Dockerfile` is what `autohisab-business deploy --target platform`
builds and pushes. On every pod boot, `docker-entrypoint.sh` runs **before**
the server accepts traffic:

1. `prisma migrate deploy` — only when the app ships `prisma/schema.prisma`.
2. `npm run db:seed --if-present` — a no-op unless the app defines a `db:seed`
   script. Seed scripts must be **idempotent** (upsert / skip existing rows);
   this runs on every boot, including replicas and restarts.
3. `npm run start` — any failed step aborts the boot (`set -e`), so a pod that
   could not reach the schema its code expects crash-loops visibly instead of
   serving broken data.

Because the boot sequence lives in the image, each `deploy` (which auto-bumps
the patch version in `flashmandu.app.toml`) ships its migrations and seed
together with the code that needs them.

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
