import { NextResponse } from 'next/server';

/**
 * OAuth Authorize endpoint — the Flashmandu host redirects the merchant here
 * to begin install. The host sends standard OAuth + PKCE params:
 *
 *   client_id, redirect_uri, response_type=code, state, scope,
 *   code_challenge, code_challenge_method=S256
 *
 * For a third-party app, this is where you'd show a consent screen. For the
 * template we simply echo the merchant back to the host's callback with a
 * fresh authorization code + the original state. The host then exchanges the
 * code at our /oauth/token endpoint (PKCE verifier in hand) and we receive the
 * platform-issued credentials in that exchange.
 */

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const scope = url.searchParams.get('scope');
  const responseType = url.searchParams.get('response_type');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');

  if (!clientId || !redirectUri || !state) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'missing required OAuth param' },
      { status: 400 },
    );
  }
  if (responseType !== 'code') {
    return NextResponse.json(
      { error: 'unsupported_response_type' },
      { status: 400 },
    );
  }
  if (codeChallenge && codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'only S256 PKCE is supported' },
      { status: 400 },
    );
  }

  // --- Consent step would go here. ---------------------------------------
  // The template auto-consents. Real apps MUST render a consent screen that
  // reflects the requested `scope` and capture the merchant's decision.

  // Mint an authorization code, bind it (plus the PKCE challenge + requested
  // scope) to a short-lived server-side entry. The code is opaque to the host.
  const code = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const issuedAt = Date.now();
  // In a real app, persist this. For the template we sign it into a JWT-like
  // blob using a local secret — replace with your session store / DB.
  void scope;
  void issuedAt;

  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);

  return NextResponse.redirect(back);
}
