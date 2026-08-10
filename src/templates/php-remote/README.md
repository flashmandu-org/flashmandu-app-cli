# Acme AutoHisab Business App (PHP)

A framework-free PHP skeleton for a Flashmandu **remote app**. No framework, no
composer install needed for the dev loop — just PHP 8.2+.

## Layout

- `public/index.php` — a runnable dev server implementing the full remote-app
  contract: the identity homepage, the OAuth PKCE endpoints
  (`/oauth/authorize`, `/oauth/callback`, `/oauth/token`), and the HMAC-verified
  webhook receiver (`/webhooks/flashmandu`).
- `src/WebhookVerifier.php` — a dependency-free HMAC verifier so `php -S` works
  before `composer install`. Feed it `php://input` and the request headers.
  **On composer, delete it and use `Flashmandu\AppSdk\Webhooks\Verifier`** from
  `flashmandu/app-sdk` — same algorithm, typed result, PSR-7-aware headers.
- `src/Manifest.php` — `AppProvider` implementation for **in-process** installs
  (Track A: a composer package inside the platform). Requires
  `flashmandu/app-sdk` (`composer install`). Not needed for the remote dev loop.
- `src/InstallMigration.stub.php` — copy into your migrations directory for any
  app-local install state.

## Dev loop

```bash
autohisab-business dev --app-command "php -S localhost:3000 -t public"
```

The CLI starts this server, opens a public tunnel, registers the app on the
dev-box, and writes `.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored).
The server reads that file automatically — open http://localhost:3000 to see
your app's identity as the platform sees it.

Received webhooks are verified and appended to `.flashmandu/webhooks.log`.
Credentials delivered by the platform at install are persisted to
`.flashmandu/credentials.json`.

## Moving to production

Mount the four endpoints from `public/index.php` in your real app (Laravel,
Symfony, Slim — anything), swap `WebhookVerifier` for the SDK's
`Flashmandu\AppSdk\Webhooks\Verifier`, store the install-time
`api_token` / `webhook_secret` in your own secret store, and submit with
`autohisab-business push`.
