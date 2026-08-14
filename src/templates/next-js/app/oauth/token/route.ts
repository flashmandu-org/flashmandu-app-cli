/* @flashmandu-template app/oauth/token/route.ts@0.4.0 */
import { createOAuthRoutes } from '@flashmandu/app-bridge/next/routes';
import { loadConfig } from '@flashmandu/app-bridge/server';

/**
 * OAuth Token + credential-delivery endpoint. The Flashmandu host POSTs here
 * twice during install: the PKCE code-for-token exchange, then the signed
 * credential delivery (`{api_token, webhook_secret, ...}`). See
 * `@flashmandu/app-bridge/next/routes`' `createOAuthRoutes` for the full
 * contract, including where credentials are stored
 * (`.flashmandu/install.<app_id>.json`, gitignored — replace with your real
 * secret store in production).
 */
export const POST = createOAuthRoutes(loadConfig()).token;
