<?php

declare(strict_types=1);

/**
 * Flashmandu PHP-native dev server — framework-free, zero composer deps.
 *
 * Run it directly:
 *   php -S localhost:3000 -t public
 *
 * Or let the CLI run the whole loop (tunnel + dev-box registration + secrets):
 *   autohisab-business dev --app-command "php -S localhost:3000 -t public"
 *
 * Implements the full remote-app contract:
 *   GET  /                       identity page (calls the dev-box /api/apps/me)
 *   GET  /oauth/authorize        dev-box install entrypoint (PKCE consent)
 *   GET  /oauth/callback         shows the code/state the dev-box returned
 *   POST /oauth/token            PKCE exchange + signed credential delivery
 *   POST /webhooks/flashmandu    HMAC-verified event webhook receiver
 *
 * Config resolution: FLASHMANDU_* env vars first, then the newest
 * .flashmandu/sandbox-secrets.<app>.json written by `autohisab-business dev`.
 */

require dirname(__DIR__).'/src/WebhookVerifier.php';

use Acme\AutohisabBusinessApp\WebhookVerifier;

/** @return array{api_token: ?string, webhook_secret: ?string, dev_box: string, app_id: ?string} */
function flashmandu_config(): array
{
    $secrets = [];
    foreach (glob(dirname(__DIR__).'/.flashmandu/sandbox-secrets.*.json') ?: [] as $file) {
        $decoded = json_decode((string) file_get_contents($file), true);
        if (is_array($decoded)) {
            $secrets = $decoded;
            break;
        }
    }

    $env = static fn (string $name): ?string => ($v = getenv($name)) !== false && $v !== '' ? $v : null;

    return [
        'api_token' => $env('FLASHMANDU_API_TOKEN') ?? ($secrets['api_token'] ?? null),
        'webhook_secret' => $env('FLASHMANDU_WEBHOOK_SECRET') ?? ($secrets['webhook_secret'] ?? null),
        'dev_box' => rtrim((string) ($env('FLASHMANDU_DEV_BOX_BASE_URL') ?? ($secrets['dev_box_base_url'] ?? '')), '/'),
        'app_id' => is_string($secrets['app_id'] ?? null) ? $secrets['app_id'] : null,
    ];
}

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
}

/** @return array<string, string> */
function request_headers(): array
{
    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (str_starts_with($key, 'HTTP_')) {
            $name = implode('-', array_map('ucfirst', explode('_', strtolower(substr($key, 5)))));
            $headers[$name] = (string) $value;
        }
    }

    return $headers;
}

/** @return list<array{at: ?string, event: ?string, delivery_id: ?string}> */
function read_webhook_log(int $limit = 20): array
{
    $file = dirname(__DIR__).'/.flashmandu/webhooks.log';
    if (! is_file($file)) {
        return [];
    }
    $lines = array_filter(explode("\n", (string) file_get_contents($file)), static fn ($l) => $l !== '');
    $sliced = array_slice($lines, max(0, count($lines) - $limit));
    $out = [];
    foreach ($sliced as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded)) {
            $out[] = [
                'at' => is_string($decoded['at'] ?? null) ? $decoded['at'] : null,
                'event' => is_string($decoded['event'] ?? null) ? $decoded['event'] : null,
                'delivery_id' => is_string($decoded['delivery_id'] ?? null) ? $decoded['delivery_id'] : null,
            ];
        }
    }

    return array_reverse($out);
}

function homepage(array $config): void
{
    header('Content-Type: text/html; charset=utf-8');
    $appName = 'Flashmandu App';

    // Resolve /api/apps/me when provisioned.
    $me = null;
    $meError = null;
    if ($config['api_token'] !== null && $config['dev_box'] !== '') {
        $ctx = stream_context_create(['http' => [
            'header' => "Authorization: Bearer {$config['api_token']}\r\nAccept: application/json\r\n",
            'ignore_errors' => true,
            'timeout' => 5,
        ]]);
        $body = @file_get_contents($config['dev_box'].'/api/apps/me', false, $ctx);
        $decoded = is_string($body) ? json_decode($body, true) : null;
        if (is_array($decoded) && isset($decoded['app_id'])) {
            $me = $decoded;
            $appName = (string) ($me['name'] ?? $appName);
        } else {
            $meError = 'Could not reach the dev-box <code>/api/apps/me</code> at '
                .htmlspecialchars($config['dev_box'])
                .'. Check that the platform is running.';
        }
    } else {
        $meError = '<strong>Not registered yet.</strong> Run '
            .'<code>autohisab-business dev --app-command "php -S localhost:3000 -t public"</code> '
            .'— it writes <code>.flashmandu/sandbox-secrets.&lt;app&gt;.json</code>, which this server reads automatically.';
    }

    $events = read_webhook_log();
    ?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars($appName) ?> · Flashmandu</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@flashmandu/app-bridge-ui/dist/tokens.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@flashmandu/app-bridge-ui/dist/components.css">
    <style>
        /* ------------------------------------------------------------------
           THE ONE RULE: nothing here redefines a `.fm-*` class. Those belong
           to @flashmandu/app-bridge-ui, linked above; a same-name rule in this
           block would silently beat the kit at equal specificity and the app
           would drift away from the host from its very first commit. This
           template used to do exactly that — `.fm-container` at 880px with no
           gutter, `.fm-card` at 20px padding — so a scaffolded app rendered as
           a narrow reading column beside a 1280px full-bleed host.

           Local styling lives under the `app-` prefix, which the kit will
           never claim. A CLI test enforces both halves of this.
           ------------------------------------------------------------------ */

        /* Offline fallback for the --fm-* tokens, in a CASCADE LAYER on
           purpose. Unlayered CSS always outranks layered CSS regardless of
           order, so the kit's real tokens.css wins whenever the CDN is
           reachable, and these only take effect on an offline dev box. Do NOT
           unwrap this block — plain `:root` here would override the entire
           0.3 token set, including the layout and control tokens that make an
           app match the host. */
        @layer fm-offline-fallback {
            :root {
                --fm-bg:#ffffff; --fm-surface:#ffffff; --fm-surface-muted:#f8fafc;
                --fm-text:#0f172a; --fm-text-muted:#64748b; --fm-border:#e2e8f0;
                --fm-primary:#18181b; --fm-primary-subtle:#f4f4f5;
                --fm-primary-ring:rgba(24,24,27,.35);
                --fm-success:#16a34a; --fm-success-subtle:#f0fdf4;
                --fm-warning:#d97706; --fm-warning-subtle:#fffbeb;
                --fm-radius-sm:0.375rem; --fm-radius-md:0.5rem; --fm-radius-lg:0.75rem;
                --fm-radius:var(--fm-radius-lg); --fm-radius-pill:9999px;
                --fm-font-sans:'Instrument Sans',ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
                --fm-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                --fm-text-xs:0.75rem; --fm-text-sm:0.875rem; --fm-text-base:1rem;
                --fm-text-lg:1.125rem; --fm-text-xl:1.375rem;
                --fm-leading:1.5;
                --fm-space-1:0.25rem; --fm-space-2:0.5rem; --fm-space-3:0.75rem;
                --fm-space-4:1rem; --fm-space-5:1.25rem; --fm-space-6:1.5rem;
                --fm-shadow-sm:0 1px 2px 0 rgb(15 23 42/.05);
                /* Layout tokens — these are what make the page read as part of
                   the host: a 1280px main with 16/24px gutters, not a column. */
                --fm-content-max:80rem; --fm-page-gutter:1rem;
                --fm-page-top:1rem; --fm-page-bottom:2.5rem;
                --fm-section-gap:1.5rem; --fm-stack-gap:1rem;
                --fm-card-padding:1.5rem; --fm-card-radius:var(--fm-radius-lg);
                --fm-card-border-width:1px; --fm-card-shadow:var(--fm-shadow-sm);
            }
            @media (min-width: 1024px) {
                :root { --fm-page-gutter:1.5rem; }
            }
            /* Dark follows the HOST's signal, matching the kit's contract.
               `prefers-color-scheme` is the standalone fallback only — inside
               an iframe it reports the viewer's OS, not the merchant's admin. */
            [data-fm-theme="dark"], .dark:not([data-fm-theme="light"]) {
                --fm-bg:#09090b; --fm-surface:#18181b; --fm-surface-muted:#27272a;
                --fm-text:#fafafa; --fm-text-muted:#a1a1aa; --fm-border:#3f3f46;
                --fm-primary:#fafafa; --fm-primary-subtle:rgba(250,250,250,.12);
                --fm-primary-ring:rgba(250,250,250,.35);
                --fm-success:#4ade80; --fm-success-subtle:rgba(74,222,128,.12);
                --fm-warning:#fbbf24; --fm-warning-subtle:rgba(251,191,36,.12);
            }
            @media (prefers-color-scheme: dark) {
                :root:not([data-fm-theme]):not(.dark) {
                    --fm-bg:#09090b; --fm-surface:#18181b; --fm-surface-muted:#27272a;
                    --fm-text:#fafafa; --fm-text-muted:#a1a1aa; --fm-border:#3f3f46;
                    --fm-primary:#fafafa; --fm-primary-subtle:rgba(250,250,250,.12);
                    --fm-primary-ring:rgba(250,250,250,.35);
                    --fm-success:#4ade80; --fm-success-subtle:rgba(74,222,128,.12);
                    --fm-warning:#fbbf24; --fm-warning-subtle:rgba(251,191,36,.12);
                }
            }
        }

        /* Document reset + app-local classes. No `.fm-*` below this line. */
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
            background: var(--fm-bg); color: var(--fm-text);
            font-family: var(--fm-font-sans); font-size: var(--fm-text-base);
            line-height: var(--fm-leading); -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        code { font-family: var(--fm-font-mono); font-size: 0.85em; }
        .app-header { display:flex; align-items:center; justify-content:space-between; gap:var(--fm-space-4); padding-bottom:var(--fm-space-4); border-bottom:1px solid var(--fm-border); }
        .app-title { font-size: var(--fm-text-lg); font-weight: 600; margin: 0; display:inline-flex; align-items:center; gap:var(--fm-space-2); }
        .app-nav { display:flex; gap:var(--fm-space-2); }
        .app-nav a { color:var(--fm-text-muted); text-decoration:none; font-size:var(--fm-text-sm); padding:var(--fm-space-2) var(--fm-space-3); border-radius:var(--fm-radius-md); }
        .app-nav a:hover { background:var(--fm-surface-muted); color:var(--fm-text); }
        .app-events { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:var(--fm-space-2); max-height:320px; overflow:auto; }
        .app-event { display:grid; grid-template-columns:max-content 1fr max-content; gap:var(--fm-space-3); align-items:baseline; font-size:var(--fm-text-sm); padding:var(--fm-space-2) var(--fm-space-3); background:var(--fm-surface-muted); border-radius:var(--fm-radius-sm); }
        .app-event time { color:var(--fm-text-muted); font-family:var(--fm-font-mono); }
        .app-event .name { font-weight:600; font-family:var(--fm-font-mono); }
        .app-event code { color:var(--fm-text-muted); }
        .app-form { display:flex; gap:var(--fm-space-2); align-items:center; margin-top:var(--fm-space-4); }
        .app-form input { flex: 1; min-width: 0; }
    </style>
</head>
<body>
<main class="fm-app-shell">
    <div class="fm-container">
        <header class="app-header">
            <h1 class="app-title">⚡ <?= htmlspecialchars($appName) ?></h1>
            <nav class="app-nav" aria-label="Primary">
                <a href="/">Home</a>
                <a href="/oauth/authorize">Install</a>
                <a href="https://github.com/flashmandu-org" target="_blank" rel="noreferrer">Docs</a>
            </nav>
        </header>

        <section class="fm-card fm-stack">
            <h2 class="fm-card__title">App Bridge context</h2>
            <p id="bridge-context" class="fm-muted">Resolving App Bridge context…</p>
        </section>

        <section class="fm-card fm-stack">
            <h2 class="fm-card__title">Dev-box identity</h2>
            <?php if ($meError !== null): ?>
                <p class="fm-muted"><?= $meError ?></p>
            <?php else: ?>
                <dl class="fm-kv">
                    <dt>App ID</dt><dd><?= htmlspecialchars((string) $me['app_id']) ?></dd>
                    <dt>Name</dt><dd><?= htmlspecialchars((string) ($me['name'] ?? '')) ?></dd>
                    <dt>Profile</dt><dd><?= htmlspecialchars((string) ($me['profile_id'] ?? '')) ?></dd>
                    <dt>Scopes</dt>
                    <dd>
                        <?php foreach (($me['scopes'] ?? []) as $s): ?><span class="fm-chip"><?= htmlspecialchars((string) $s) ?></span><?php endforeach; ?>
                        <?php if (! ($me['scopes'] ?? [])) echo '<span class="fm-muted">(none)</span>'; ?>
                    </dd>
                    <dt>Events</dt>
                    <dd>
                        <?php foreach (($me['subscribed_events'] ?? []) as $s): ?><span class="fm-chip"><?= htmlspecialchars((string) $s) ?></span><?php endforeach; ?>
                        <?php if (! ($me['subscribed_events'] ?? [])) echo '<span class="fm-muted">(none)</span>'; ?>
                    </dd>
                </dl>
            <?php endif; ?>
        </section>

        <section class="fm-card fm-stack">
            <h2 class="fm-card__title">Recent webhook events</h2>
            <?php if ($events === []): ?>
                <p class="fm-muted">No webhooks received yet. Deliveries will be listed here once they arrive.</p>
            <?php else: ?>
                <ul class="app-events">
                    <?php foreach ($events as $e): ?>
                        <li class="app-event">
                            <time><?= htmlspecialchars((string) ($e['at'] ?? '—')) ?></time>
                            <span class="name"><?= htmlspecialchars((string) ($e['event'] ?? '(unknown)')) ?></span>
                            <code><?= htmlspecialchars((string) substr((string) ($e['delivery_id'] ?? ''), 0, 8)) ?></code>
                        </li>
                    <?php endforeach; ?>
                </ul>
            <?php endif; ?>
            <form class="app-form" action="javascript:void(0)" onsubmit="return false" aria-label="Send a test toast to the host shell">
                <input id="toast-msg" class="fm-input" type="text" placeholder="Toast message (uses App Bridge when embedded)" />
                <button class="fm-btn" type="button" onclick="sendToast()">Send toast</button>
            </form>
        </section>
    </div>
</main>

<script type="module">
    // App Bridge resolves only inside the Flashmandu embed iframe. Degrade
    // gracefully when the page is browsed standalone (php -S dev mode).
    const target = document.getElementById('bridge-context');
    let bridge = null;
    const inIframe = window.self !== window.top;
    if (!inIframe) {
        target.textContent = 'Running standalone (not embedded). The App Bridge only resolves inside the Flashmandu embed iframe.';
    } else {
        import('https://cdn.jsdelivr.net/npm/@flashmandu/app-bridge/dist/index.js')
            .then((mod) => { bridge = mod.createAppBridge(); return bridge.ready(); })
            .then((ctx) => {
                const scopes = (ctx.scopes ?? []).map((s) => `<span class="fm-chip">${s}</span>`).join('')
                    || '<span class="fm-muted">(none)</span>';
                target.classList.remove('fm-muted');
                target.outerHTML = `<dl class="fm-kv">
                    <dt>Origin</dt><dd>${ctx.origin ?? '—'}</dd>
                    <dt>App ID</dt><dd>${ctx.appId ?? '—'}</dd>
                    <dt>Profile</dt><dd>${ctx.profileId ?? '—'}</dd>
                    <dt>Target</dt><dd>${ctx.target ?? '—'}</dd>
                    <dt>Locale</dt><dd>${ctx.locale ?? '—'}</dd>
                    <dt>Scopes</dt><dd>${scopes}</dd>
                </dl>`;
            })
            .catch((err) => {
                target.textContent = 'App Bridge did not resolve: ' + (err?.message ?? err);
            });
    }
    function sendToast() {
        const msg = document.getElementById('toast-msg').value.trim();
        if (! msg) return;
        if (bridge && typeof bridge.toast === 'function') {
            bridge.toast(msg, 'success');
        } else {
            alert('Toast requires the App Bridge (embedded mode). Message was: ' + msg);
        }
    }
    window.sendToast = sendToast;
</script>
</body>
</html>
    <?php
}

$config = flashmandu_config();
$method = (string) $_SERVER['REQUEST_METHOD'];
$path = (string) parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH);

switch (true) {
    case $path === '/' && $method === 'GET':
        homepage($config);
        break;

    case $path === '/oauth/authorize' && $method === 'GET':
        // The dev-box redirects the merchant here with a PKCE challenge. A real
        // app renders a consent screen; the dev flow just redirects straight
        // back with a code so the loop completes without UI.
        $redirect = (string) ($_GET['redirect_uri'] ?? '');
        $state = (string) ($_GET['state'] ?? '');
        if ($redirect === '') {
            json_response(['error' => 'missing redirect_uri'], 422);
            break;
        }
        $separator = str_contains($redirect, '?') ? '&' : '?';
        header('Location: '.$redirect.$separator.http_build_query([
            'code' => bin2hex(random_bytes(16)),
            'state' => $state,
        ]));
        break;

    case $path === '/oauth/callback' && $method === 'GET':
        header('Content-Type: text/html; charset=utf-8');
        echo '<h1>OAuth callback</h1><pre>'.htmlspecialchars(json_encode($_GET, JSON_PRETTY_PRINT) ?: '{}').'</pre>';
        break;

    case $path === '/oauth/token' && $method === 'POST':
        $payload = json_decode((string) file_get_contents('php://input'), true);
        if (! is_array($payload)) {
            json_response(['error' => 'invalid JSON body'], 422);
            break;
        }

        if (isset($payload['api_token'])) {
            // Signed credential delivery — persist for subsequent requests.
            $dir = dirname(__DIR__).'/.flashmandu';
            if (! is_dir($dir)) {
                mkdir($dir, 0700, true);
            }
            file_put_contents($dir.'/credentials.json', json_encode($payload, JSON_PRETTY_PRINT));
            json_response(['stored' => true]);
            break;
        }

        // PKCE code exchange — acknowledge so the platform proceeds to delivery.
        json_response(['access_token' => 'dev-placeholder', 'token_type' => 'Bearer']);
        break;

    case $path === '/webhooks/flashmandu' && $method === 'POST':
        if ($config['webhook_secret'] === null) {
            json_response(['error' => 'no webhook_secret — run autohisab-business dev first'], 503);
            break;
        }
        $body = (string) file_get_contents('php://input');
        $result = (new WebhookVerifier($config['webhook_secret']))->verify($body, request_headers());
        if (! $result['ok']) {
            json_response(['error' => $result['reason'] ?? 'verification failed'], 401);
            break;
        }
        $line = json_encode([
            'at' => date(DATE_ATOM),
            'event' => $result['event'] ?? null,
            'delivery_id' => $result['delivery_id'] ?? null,
            'payload' => json_decode($body, true),
        ]);
        file_put_contents(dirname(__DIR__).'/.flashmandu/webhooks.log', $line."\n", FILE_APPEND);
        json_response(['received' => true, 'event' => $result['event'] ?? null]);
        break;

    default:
        json_response(['error' => 'not found'], 404);
}
