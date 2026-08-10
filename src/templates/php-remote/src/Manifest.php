<?php

declare(strict_types=1);

namespace Acme\AutohisabBusinessApp;

use Flashmandu\AppSdk\AppManifest;
use Flashmandu\AppSdk\AppProvider;
use Flashmandu\AppSdk\Scope;

/**
 * Entry point the Flashmandu platform discovers and invokes. Register this
 * class in the platform's config/apps.php `registered` list (or submit the app
 * to the marketplace via `autohisab-business push`).
 *
 * The manifest() return value drives install scopes and the OAuth/webhook URLs.
 * Override the URL constants to match your hosted app.
 */
final class Manifest implements AppProvider
{
    public const AUTHORIZE_URL = 'https://APP-HOST/oauth/authorize';
    public const TOKEN_URL = 'https://APP-HOST/oauth/token';
    public const WEBHOOK_URL = 'https://APP-HOST/webhooks/flashmandu';

    public function manifest(): AppManifest
    {
        return new AppManifest(
            id: 'acme/autohisab-business-app',
            name: 'Acme AutoHisab Business App',
            version: '0.1.0',
            scopes: [Scope::ReadOrders],
        );
    }
}
