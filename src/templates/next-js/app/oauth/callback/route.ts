import { NextResponse } from 'next/server';

/**
 * Developer-facing OAuth callback landing page.
 *
 * NOTE: The Flashmandu host has its OWN OAuth callback (it does not redirect
 * merchants here). The host's install flow is:
 *
 *   host begin-install  ->  merchant lands on app's /oauth/authorize
 *   merchant consents   ->  app redirects to host's callback with code+state
 *   host exchanges      ->  POSTs code to app's /oauth/token (PKCE)
 *   host delivers creds ->  POSTs {api_token, webhook_secret, ...} to /oauth/token
 *
 * This route exists purely as a developer convenience — a place to land the
 * browser after a manual install test and show the app identity. It is NOT
 * part of the OAuth contract. If you want a post-install deep-link target,
 * have your `/oauth/authorize` page render a link here.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const installed = url.searchParams.get('installed') === '1';
  return NextResponse.json({
    message: installed
      ? 'App installed. Visit the host admin to confirm.'
      : 'OAuth callback landing (developer convenience; not in the host contract).',
  });
}
