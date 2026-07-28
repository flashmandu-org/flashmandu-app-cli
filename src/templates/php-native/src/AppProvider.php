<?php

declare(strict_types=1);

namespace Acme\FlashmanduApp;

use Flashmandu\AppSdk\AppManifest;
use Flashmandu\AppSdk\AppProvider;
use Flashmandu\AppSdk\Scope;

/**
 * Entry point the Flashmandu platform discovers and invokes. Register this
 * class in the platform's config/apps.php `registered` list (or submit the app
 * to the marketplace via `flashmandu-app push`).
 *
 * The manifest() return value drives install scopes and the OAuth/webhook URLs.
 * Override the URL constants to match your hosted app.
 */
final class Manifest implements AppProvider
{
    public const string AUTHORIZE_URL = 'https://APP-HOST/oauth/authorize';
    public const string TOKEN_URL = 'https://APP-HOST/oauth/token';
    public const string WEBHOOK_URL = 'https://APP-HOST/webhooks/flashmandu';

    public function manifest(): AppManifest
    {
        return new AppManifest(
            id: 'acme/flashmandu-app',
            name: 'Acme Flashmandu App',
            version: '0.1.0',
            scopes: [Scope::ReadOrders],
        );
    }
}
