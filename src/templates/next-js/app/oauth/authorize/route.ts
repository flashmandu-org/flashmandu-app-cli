/* @flashmandu-template app/oauth/authorize/route.ts@0.4.0 */
import { createOAuthRoutes } from '@flashmandu/app-bridge/next/routes';
import { loadConfig } from '@flashmandu/app-bridge/server';

/**
 * OAuth Authorize endpoint — the Flashmandu host redirects the merchant here
 * to begin install. See `@flashmandu/app-bridge/next/routes`' `createOAuthRoutes`
 * for the full contract (PKCE param validation, auto-consent, code minting).
 *
 * For a third-party app that needs a real consent screen, do not call the
 * factory here — implement your own `GET` and redirect to the platform's
 * callback yourself once the merchant has consented.
 */
export const GET = createOAuthRoutes(loadConfig()).authorize;
