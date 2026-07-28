# @flashmandu/app-cli

The developer CLI for building, testing and publishing **Flashmandu storefront
apps**. Think of it as the Shopify-CLI-equivalent for the Flashmandu platform.

> **Reserved verb semantics.** `dev` runs the local sandbox loop only — it
> never publishes and never contacts a production host. `push` submits to the
> dev-box marketplace only. **No production host is compiled into this CLI.**
> It talks to whichever dev-box `base_url` the developer configures.

## Install

```bash
npm install -g @flashmandu/app-cli
```

Requires Node 18.17+.

## Quick start

```bash
# 1. Point the CLI at your dev box (https only) and log in.
flashmandu-app config set base_url https://dev.flashmandu.example
flashmandu-app login

# 2. Scaffold an app.
flashmandu-app init my-app --template next-js
cd my-app

# 3. Run the local dev loop (app server + tunnel + sandbox register).
flashmandu-app dev

# 4. When ready, submit to the dev-box marketplace for operator review.
flashmandu-app push
```

## Commands

| Command                 | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `login`                 | OAuth device-code flow against the dev-box; stores a Bearer token.            |
| `logout [profile]`      | Remove a stored profile.                                                      |
| `whoami`                | `GET /api/apps/me` round-trip to verify the stored token.                     |
| `init [dir]`            | Scaffold a Next.js or PHP-native app from a bundled template.                 |
| `dev`                   | Start app server + public tunnel (cloudflared/ngrok/external) + POST `/api/apps/dev/register`; write secrets to `.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored); open the sandbox browser. |
| `push`                  | `POST /api/apps/app-submissions` (open, throttled) — marketplace submit only. |
| `hooks`                 | `GET /api/apps/hooks` — public hook catalog as a table.                       |
| `logs`                  | `GET /api/apps/dev/{appId}/deliveries` — recent/tailing webhook deliveries.   |
| `config set/get/list`   | Manage the active profile's `base_url`.                                       |

## Where things live

- Credentials: `~/.flashmandu/credentials.toml` (mode 0600). Per-profile
  `token` + `base_url`.
- Sandbox secrets: `<app>/.flashmandu/sandbox-secrets.<app>.json` (0600,
  auto-added to `.gitignore`). Contains `api_token` + `webhook_secret`
  issued once by the dev-box.
- Manifest: `<app>/flashmandu.app.toml` — slug, version, OAuth/webhook URLs,
  scopes, subscribed events. The `slug` is the developer-chosen leaf of the
  platform's `<publisher>/<slug>` app identity; the host namespaces it by
  publisher. A legacy `id` (e.g. `acme/my-app`) is still accepted as an alias
  — its leaf after any `/` is used as the slug.

## Contracts the CLI assumes

These are the host endpoints the CLI talks to. All paths are under the
configured `base_url`:

| Method & path                                | Auth            | Purpose                                                                |
| -------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `GET /api/apps/me`                           | Bearer api_token | Identity of the installed app (`app_id`, `name`, `profile_id`, `scopes`, `subscribed_events`). |
| `GET /api/apps/hooks`                        | none (throttled) | Hook catalog.                                                          |
| `POST /api/apps/app-submissions`             | none (throttled) | Marketplace submission (`developer_name`, `developer_email`, `app_id`, `name`, `source_url`, `description`). |
| `POST /api/apps/dev/register`                | Bearer dev token | Wraps `AppManager::installRemoteApp`; returns `{install_id, api_token, webhook_secret, scopes}` **once**. |
| `GET /api/apps/dev/{appId}/deliveries`       | Bearer dev token | Webhook delivery log (recent attempts + statuses).                     |

### Webhook signature (must verify in your app)

```
signature  = hash_hmac('sha256', $timestamp.'.'.$body, $webhook_secret)
headers    = X-App-Signature / X-App-Timestamp / X-App-Delivery (UUID) / X-App-Event
body       = { "event": "<hook>", "payload": { ... } }
```

The Next.js template ships a constant-time verifier at
`app/webhooks/flashmandu/route.ts`; the PHP template ships the equivalent
`WebhookVerifier`. Always verify over the RAW body (not a re-serialized copy).

### OAuth install flow (PKCE S256)

The platform redirects the merchant to your app's `authorize_url` with
`client_id`, `redirect_uri`, `response_type=code`, `state`, `scope`,
`code_challenge`, `code_challenge_method=S256`. Your app returns the merchant
to the platform's callback with `code` + `state`. The platform then POSTs the
PKCE code exchange to your `token_url`, and POSTs the credential payload
(`{api_token, webhook_secret, scopes, ...}` HMAC-signed with the install's
`webhook_secret`) to the same `token_url` (or a separate
`credential_delivery_url`).

## Developing the CLI itself

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # no emit
npm run dev         # tsx src/index.ts <args>
```

Optional tunnel providers (`cloudflared`, `ngrok`) are listed under
`optionalDependencies`. The CLI lazily `require()`s whichever the developer
selects and prints a clear install hint if it's missing.

## Releasing

```bash
bin/release.sh 0.2.1
```

Bumps `package.json`, tags `v0.2.1`, and pushes. The Release workflow builds,
publishes to npm, and opens the GitHub release.

## License

Proprietary. © Flashmandu.
