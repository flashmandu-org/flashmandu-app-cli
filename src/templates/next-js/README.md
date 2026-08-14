# AutoHisab Business App — Next.js

A Next.js (App Router, TypeScript) starter for an AutoHisab Business app.
Wires the OAuth + webhook contracts the platform expects, and renders through
the host's own chrome so the embed is indistinguishable from a native page.

## Page chrome — read this first

**Do not render a desktop page heading.** Breadcrumbs, page actions and the
dirty ⇄ Save/Discard swap live in the HOST command bar; the app declares them
with `usePageChrome` and the host draws them. An in-page title bar is exactly
what makes an embed look bolted-on.

`@flashmandu/app-bridge-ui/react`'s `Page` wraps that in one component (wired
once, in `app/layout.tsx`, via `configurePageChrome`):

```tsx
import Link from 'next/link';
import { Page } from '@flashmandu/app-bridge-ui/react';

<Page
  title="Items"
  crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Items' }]}
  actions={[{ id: 'new', label: 'New item', variant: 'primary', onSelect: create }]}
  dirty={form.isDirty}
  linkComponent={Link}
>
  …
</Page>
```

Below `lg`, where the host command bar is not visible, `Page` renders the
mobile breadcrumb + heading mirror inside the iframe. It is `lg:hidden` in
CSS, so the two never both appear and there is no hydration flash.

## What's included

- All shared server/client code — the OAuth route factories, the webhook
  verifier + dedupe, the config loader, the GraphQL client, and `Page` itself
  — now ships from `@flashmandu/app-bridge` (`/server`, `/next/routes`,
  `/react`) and `@flashmandu/app-bridge-ui/react`. Nothing below re-implements
  them; run `autohisab-business kit sync` to pull the pinned version and
  `autohisab-business doctor` to check the app is still wired to it correctly.
- `app/page.tsx` — dashboard. No heading; chrome comes from the host.
- `app/items/page.tsx` — the standard list surface: `IndexTable` with sortable
  columns, a pinned first column, selection + bulk actions, pagination in the
  shell footer, and **skeleton-first loading** (placeholder rows, never a blank
  pane and never a layout jump).
- `app/(admin)/settings/page.tsx` — dirty-state example: while the form is
  dirty the host swaps its bar for native Save / Discard, which still call back
  into this page by action id.
- `app/loading.tsx` / `app/error.tsx` / `app/not-found.tsx` — the route-state
  scaffolds every screen inherits by default: a skeleton while a route
  resolves, a retryable error callout, and an empty-state 404.
- `app/oauth/{authorize,callback,token}/route.ts` — three-line factory calls
  onto `createOAuthRoutes(loadConfig())`. See the SDK's `GUIDELINES.md` /
  `README.md` for the full OAuth + credential-delivery contract these
  implement.
- `app/webhooks/flashmandu/route.ts` — `createWebhookRoute({ cfg, onUninstalled })`.
  Verifies `X-App-Signature` over `${X-App-Timestamp}.${rawBody}`, dedupes on
  `X-App-Delivery`, and calls `lib/purge.ts`'s `purgeProfileData` on
  `app.uninstalled` / `profile.data.erased`.
- `lib/purge.ts` — `purgeProfileData(profileId)`: delete/anonymize everything
  this app stored for a profile on uninstall. Ships as a working no-op stub
  (`{}`); fill it in as you add persistence.

## Keeping the kit current

```bash
autohisab-business kit status   # installed vs CLI-pinned SDK versions
autohisab-business kit sync     # vendor the pinned tgz, rewrite package.json, npm install
autohisab-business doctor       # static checks against the recorded remote-app incidents
autohisab-business upgrade      # re-apply kit-owned template files (next.config.js,
                                 # route factories, route-state scaffolds) that are
                                 # still at a known template version; reports
                                 # hand-edited files as "skipped (forked)"
```

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
