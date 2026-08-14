/* @flashmandu-template app/oauth/callback/route.ts@0.4.0 */
import { createOAuthRoutes } from '@flashmandu/app-bridge/next/routes';
import { loadConfig } from '@flashmandu/app-bridge/server';

/**
 * Developer-facing OAuth callback landing page.
 *
 * NOTE: the Flashmandu host has its OWN OAuth callback (it does not redirect
 * merchants here). This route is a developer convenience — a place to land
 * the browser after a manual install test — not part of the OAuth contract.
 */
export const GET = createOAuthRoutes(loadConfig()).callback;
