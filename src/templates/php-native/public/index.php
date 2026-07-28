<?php

declare(strict_types=1);

/**
 * Flashmandu PHP-native dev server — framework-free, zero composer deps.
 *
 * Run it directly:
 *   php -S localhost:3000 -t public
 *
 * Or let the CLI run the whole loop (tunnel + dev-box registration + secrets):
 *   flashmandu-app dev --app-command "php -S localhost:3000 -t public"
 *
 * Implements the full remote-app contract:
 *   GET  /                       identity page (calls the dev-box /api/apps/me)
 *   GET  /oauth/authorize        dev-box install entrypoint (PKCE consent)
 *   GET  /oauth/callback         shows the code/state the dev-box returned
 *   POST /oauth/token            PKCE exchange + signed credential delivery
 *   POST /webhooks/flashmandu    HMAC-verified event webhook receiver
 *
 * Config resolution: FLASHMANDU_* env vars first, then the newest
 * .flashmandu/sandbox-secrets.<app>.json written by `flashmandu-app dev`.
 */

require dirname(__DIR__).'/src/WebhookVerifier.php';

use Acme\FlashmanduApp\WebhookVerifier;

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

function homepage(array $config): void
{
    header('Content-Type: text/html; charset=utf-8');
    echo '<h1>Flashmandu App (PHP)</h1><p>This is a starter app. Wire your UI here.</p>';

    if ($config['api_token'] === null || $config['dev_box'] === '') {
        echo '<p><strong>Not registered yet.</strong> Run <code>flashmandu-app dev --app-command "php -S localhost:3000 -t public"</code> — it writes <code>.flashmandu/sandbox-secrets.&lt;app&gt;.json</code>, which this server reads automatically.</p>';

        return;
    }

    $context = stream_context_create(['http' => [
        'header' => "Authorization: Bearer {$config['api_token']}\r\nAccept: application/json\r\n",
        'ignore_errors' => true,
        'timeout' => 5,
    ]]);
    $body = @file_get_contents($config['dev_box'].'/api/apps/me', false, $context);
    $me = is_string($body) ? json_decode($body, true) : null;

    if (! is_array($me) || ! isset($me['app_id'])) {
        echo '<p><strong>Could not reach the dev-box /api/apps/me.</strong> Check that the platform is running at '.htmlspecialchars($config['dev_box']).'.</p>';

        return;
    }

    echo '<ul>';
    echo '<li>App ID: '.htmlspecialchars((string) $me['app_id']).'</li>';
    echo '<li>Name: '.htmlspecialchars((string) ($me['name'] ?? '')).'</li>';
    echo '<li>Profile: '.htmlspecialchars((string) ($me['profile_id'] ?? '')).'</li>';
    echo '<li>Scopes: '.htmlspecialchars(implode(', ', $me['scopes'] ?? []) ?: '(none)').'</li>';
    echo '<li>Events: '.htmlspecialchars(implode(', ', $me['subscribed_events'] ?? []) ?: '(none)').'</li>';
    echo '</ul>';
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
            json_response(['error' => 'no webhook_secret — run flashmandu-app dev first'], 503);
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
