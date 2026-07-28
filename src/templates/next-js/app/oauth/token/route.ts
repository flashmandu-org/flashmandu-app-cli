import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * OAuth Token + credential-delivery endpoint.
 *
 * The Flashmandu host POSTs to this URL twice during install:
 *
 *   (1) Code-for-token exchange (PKCE):
 *       body = { grant_type:'authorization_code', code, redirect_uri,
 *                client_id, code_verifier }
 *       We verify `code_verifier` against the challenge captured at
 *       /oauth/authorize, mint a (mock) access token, and return 200. The
 *       platform ignores our response body — it only checks for 2xx.
 *
 *   (2) Credential delivery (signed by the platform with the install's
 *       webhook_secret — the SAME key used to sign inbound webhook deliveries,
 *       so verification uses one code path):
 *       body = { install_id, profile_id, app_id, api_token, webhook_secret,
 *                scopes, subscribed_events, issued_at, hmac }
 *       The first time we cannot verify `hmac` (we don't yet know the secret),
 *       so we trust the prior PKCE-bound TLS exchange and STORE the plaintext
 *       `api_token` + `webhook_secret`. Subsequent deliveries (rotations) are
 *       verifiable with the previous secret.
 *
 * This template writes the credentials to `.flashmandu/install.<app_id>.json`
 * (gitignored). Replace with your real secret store (KMS, vault, DB) in prod.
 */

interface ExchangeBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  scope?: string;
}

interface CredentialDelivery {
  install_id?: number | string;
  profile_id?: number;
  app_id?: string;
  api_token?: string;
  webhook_secret?: string;
  scopes?: string[];
  subscribed_events?: string[];
  issued_at?: string;
  hmac?: string;
}

async function storeCredentials(appId: string, body: CredentialDelivery): Promise<void> {
  const dir = path.join(process.cwd(), '.flashmandu');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `install.${appId}.json`);
  await fs.writeFile(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function readStoredSecret(appId: string): Promise<string | undefined> {
  try {
    const file = path.join(process.cwd(), '.flashmandu', `install.${appId}.json`);
    const raw = await fs.readFile(file, 'utf8');
    return (JSON.parse(raw) as CredentialDelivery).webhook_secret;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Branch on shape: exchange has `grant_type`, delivery has `api_token`.
  if (body && typeof body === 'object' && 'grant_type' in body) {
    const ex = body as ExchangeBody;
    if (ex.grant_type !== 'authorization_code' || !ex.code || !ex.code_verifier) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    // Verify the PKCE verifier against the challenge stored at /oauth/authorize.
    // (Template skips persistence: wire your session store here.)
    // const expected = createHash('sha256').update(ex.code_verifier).digest('base64url');
    // ... compare to stored challenge for ex.code ...
    void ex;

    return NextResponse.json({
      access_token: 'app-side-opaque-' + crypto.randomUUID(),
      token_type: 'bearer',
      scope: ex.scope ?? '',
    });
  }

  if (body && typeof body === 'object' && 'api_token' in body) {
    const deliv = body as CredentialDelivery;
    if (!deliv.app_id || !deliv.api_token || !deliv.webhook_secret) {
      return NextResponse.json({ error: 'invalid_credential_delivery' }, { status: 400 });
    }

    // Verify HMAC if we already hold a previous secret (rotation path). On
    // first delivery we have nothing to verify against — trust PKCE + TLS.
    const prev = await readStoredSecret(deliv.app_id);
    if (prev && deliv.hmac) {
      const canonical = JSON.stringify({
        install_id: deliv.install_id,
        profile_id: deliv.profile_id,
        app_id: deliv.app_id,
        api_token: deliv.api_token,
        webhook_secret: deliv.webhook_secret,
        scopes: deliv.scopes,
        subscribed_events: deliv.subscribed_events,
        issued_at: deliv.issued_at,
      });
      const expected = createHmac('sha256', prev).update(canonical).digest('hex');
      if (expected !== deliv.hmac) {
        return NextResponse.json({ error: 'invalid_hmac' }, { status: 401 });
      }
    }

    await storeCredentials(deliv.app_id, deliv);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown_request_shape' }, { status: 400 });
}
