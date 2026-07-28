# Acme Flashmandu App (PHP)

A composer-package skeleton for a Flashmandu storefront app requiring
`flashmandu/app-sdk`.

## Layout

- `src/Manifest.php` — `AppProvider` implementation. Register this class in the
  platform's `config/apps.php`, or submit via `flashmandu-app push`.
- `src/WebhookVerifier.php` — framework-free HMAC verifier for inbound
  webhooks. Feed it `php://input` and the request headers.
- `src/InstallMigration.stub.php` — copy into your migrations directory for
  any app-local install state.

## Local dev

```bash
composer install
composer test
flashmandu-app dev
```

`flashmandu-app dev` writes the dev-box sandbox credentials into
`.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored). Read them at
runtime (do NOT hardcode):

```php
$secrets = json_decode(file_get_contents(__DIR__.'/../.flashmandu/sandbox-secrets.acme-flashmandu-app.json'), true);
$verifier = new WebhookVerifier($secrets['webhook_secret']);
```
