# @flashmandu/autohisab-business-cli

The developer CLI for building, testing and publishing **AutoHisab Business storefront
apps**. Think of it as the Shopify-CLI-equivalent for the AutoHisab Business platform.

> **Reserved verb semantics.** `dev` runs the local sandbox loop only — it
> never publishes and never contacts a production host. `push` submits to the
> dev-box marketplace only. **No production host is compiled into this CLI.**
> It talks to whichever dev-box `base_url` the developer configures.

## Install

```bash
npm install -g @flashmandu/autohisab-business-cli
```

Requires Node 18.17+.

## Quick start

```bash
# 1. Point the CLI at your dev box (https only) and log in.
autohisab-business config set base_url https://dev.autohisab.example
autohisab-business login

# 2. Scaffold an app.
autohisab-business init my-app --template next-js
cd my-app

# 3. Run the local dev loop (app server + tunnel + sandbox register).
autohisab-business dev

# 4. When ready, submit to the dev-box marketplace for operator review.
autohisab-business push
```

## Commands

| Command                 | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `login`                 | OAuth device-code flow against the dev-box; stores a Bearer token.            |
| `logout [profile]`      | Remove a stored profile.                                                      |
| `whoami`                | `GET /api/apps/me` round-trip to verify the stored token.                     |
| `init [dir]`            | Scaffold a Next.js or PHP (remote) app from a bundled template.                 |
| `dev`                   | Start app server + public tunnel (cloudflared/ngrok/external) + POST `/api/apps/dev/register`; write secrets to `.flashmandu/sandbox-secrets.<app>.json` (0600, gitignored); open the sandbox browser. |
| `push`                  | `POST /api/apps/app-submissions` (open, throttled) — marketplace submit only. |
| `hooks`                 | `GET /api/apps/hooks` — public hook catalog as a table.                       |
| `hooks subscribe/unsubscribe <event>` | Edit `[webhooks].events` in the manifest. The CLI is the single writer; the next `dev`/`push`/`deploy` syncs it. |
| `hooks deliveries`      | Recent delivery attempts: event, status, attempts, latency.                   |
| `hooks replay <id>`     | Redeliver one logged webhook.                                                 |
| `logs`                  | `GET /api/apps/dev/{appId}/deliveries` — recent/tailing webhook deliveries.   |
| `config set base_url <url>` | Point the CLI at a dev box (per profile).                                 |
| `config set KEY=value` / `config list` / `config unset KEY` | Hosted-app secrets — **write-only**. `list` shows key NAMES only. Platform-target apps only. |

## Declarative webhooks and schedules

`flashmandu.app.toml` is the single source of truth for both. Nothing else
writes an app's subscription or its schedules, so what is in the file is what
the platform has after the next sync.

- **`[webhooks]`** is synced by `dev` (register) and by `push` / `deploy` (submission).
- **`[[schedules]]`** is synced by **`dev` only**, via `POST /api/apps/schedules/sync`,
  authenticated as the app itself. The platform materializes schedules per
  *enabled install*, and a marketplace submission has none yet — so `push` /
  `deploy` print your schedule blocks with a warning that they are declared but
  not applied, rather than implying they are live.

```toml
[webhooks]
# `url` is optional — omit it to use the top-level `webhook_url` that
# `deploy` rewrites for you.
url    = "https://app.example.com/webhooks/flashmandu"
events = ["order.created", "customer.updated"]

[[schedules]]
name  = "attendance-rollup"
every = "15m"

[[schedules]]
name = "nightly-reconcile"
cron = "0 18 * * *"          # profile timezone
```

Each schedule fires as an ordinary signed webhook with event `schedule.tick`
and payload `{ schedule, profile_id, scheduled_at }` — same HMAC, same retry
ladder, same delivery log as every other webhook.

Platform rules, enforced by the CLI before anything is sent:

- minimum interval **5 minutes** (`every`);
- at most **5 schedules** per app;
- names unique per app (the tick payload identifies the schedule by name);
- `every` **or** `cron`, never both.

The platform re-checks all of them at sync time and rejects the whole batch on
the first bad block; the CLI names the offending `[[schedules]]` entry and
fails the `dev` run rather than printing a green line over an empty schedule
list. `autohisab-business dev` echoes back what the *platform* stored — not
what your toml says — so the two can never silently disagree.

Legacy top-level `subscribed_events` still works, but when both are present
`[webhooks].events` wins and the CLI says so.

## Hosted-app secrets

```bash
autohisab-business config set KLAVIYO_API_KEY=pk_live_…   # encrypted at rest
autohisab-business config list                            # KEY NAMES ONLY
autohisab-business config unset KLAVIYO_API_KEY
```

Secrets are injected as env vars into the tenant container on deploy and are
**write-only**: the platform ships no read-back endpoint, by design. This is
where third-party credentials live — explicitly *not* in `settings_schema`,
which is host-readable and surfaced in the admin UI.

For `--target vercel` / `--target self` apps the command prints guidance and
exits non-zero: the platform does not run your container, so your environment
is yours to manage.

## Version-floor warnings

`dev` and `push` compare the app's `@flashmandu/app-bridge` and
`@flashmandu/app-bridge-ui` versions against the floor the platform advertises
on `GET /api/apps/capabilities`, and warn when either is behind. The check is
advisory — a host with no published floor, or an unresolvable version
(`workspace:*`, `file:…`), produces no warning and never blocks a run.

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
| `GET /api/apps/dev/{appId}/deliveries`       | Bearer dev token | Legacy dev delivery log. Used as a fallback when the endpoint below 404s. |
| `GET /api/apps/deliveries?limit=&event=&status=` | Bearer app token | Delivery log: `{ deliveries: [{ id, delivery_id, event, url, http_status, succeeded, attempt, attempts, duration_ms, dead_lettered, created_at }] }`. |
| `POST /api/apps/deliveries/{id}/replay`      | Bearer app token | Redeliver one logged webhook. Returns `{ ok, delivery_id, http_status }`. |
| `GET/PUT/DELETE /api/apps/hosted-secrets`    | Bearer dev token | Hosted-app secrets. `GET ?app_id=` → `{ keys: [...] }` (names only); `PUT { app_id, key, value }`; `DELETE ?app_id=&key=`. |
| `GET /api/apps/capabilities`                 | Bearer dev token | Runtime capabilities; optional `bridge_version_floor: { "app-bridge": "x.y.z", "app-bridge-ui": "x.y.z" }`. |

Every one of these lives in `src/services/apiClient.ts` (see `ENDPOINTS`), so a
host contract change is a one-file edit.

`POST /api/apps/dev/register` and `POST /api/apps/app-submissions` additionally
carry `subscribed_events` (resolved from `[webhooks]`).

`[[schedules]]` go to `POST /api/apps/schedules/sync` as
`{ schedules: [{ name, every, interval_seconds } | { name, cron }] }`, and are
read back from `GET /api/apps/schedules`. Both are scoped to the **bearer**, so
they must be called with the app's own `api_token` (from the `dev` register
response / `.flashmandu/sandbox-secrets.*.json`) — the developer login token
resolves to the dev/cli app, which is a different app id.

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

## Shell completion

The CLI prints a tab-completion script (commands, per-command options, and
value enums like `deploy --target platform|vercel|self`), generated from the
commander program tree so it stays in sync. `completion [shell]` supports
`zsh`, `bash` and `powershell`; when the shell is omitted it is auto-detected
from `$SHELL` (or defaults to PowerShell on Windows). Add `--instructions` to
print setup guidance to stderr.

**zsh** (macOS/Linux — Warp, iTerm, Terminal all read `~/.zshrc`): add this to
`~/.zshrc` AFTER any `compinit` call (Warp runs `~/.zshrc` like any zsh):

```sh
# If your ~/.zshrc has no compinit call, add this first:
autoload -Uz compinit && compinit
eval "$(autohisab-business completion zsh)"
```

**bash**:

```sh
# macOS (Homebrew bash-completion)
autohisab-business completion bash > "$(brew --prefix)/etc/bash_completion.d/autohisab-business"
# Linux / Git Bash on Windows — append to ~/.bashrc
echo 'source <(autohisab-business completion bash)' >> ~/.bashrc
```

**Windows PowerShell / pwsh**:

```powershell
autohisab-business completion powershell >> $PROFILE
```

Restart the shell (or `source ~/.zshrc` / `. $PROFILE`) afterwards, then
verify with `autohisab-business <TAB><TAB>`.

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
