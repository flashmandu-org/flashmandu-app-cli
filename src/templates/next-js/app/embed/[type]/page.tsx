/**
 * Reference App Embed Block route (App Embed Blocks platform feature).
 *
 * This is the storefront analogue of an admin app slot: a tiny interactive
 * block that runs inside a sandboxed <iframe> on the merchant storefront and
 * talks to the host ONLY through the storefront App Bridge (postMessage).
 *
 * The platform mints a per-view, one-time signed token and loads this route as:
 *
 *   /embed/<block_type>?session_token=<token>&instance_id=<node-id>&...
 *
 * The signed token (EmbedBlockTester contract) is:
 *
 *   <body>.<sig>
 *
 * where:
 *   body = base64url( json(payload) )           // payload = the query params
 *   sig  = base64url( hmac_sha256(body + sorted_query, APP_SECRET) )
 *
 * "sorted_query" is the full query string rebuilt with keys in ascending
 * lexicographic order, RFC3986-encoded. Verification is constant-time
 * (crypto.timingSafeEqual). See docs/app-platform/embed-blocks.md for the
 * canonical algorithm.
 *
 * ── WHY THIS FILE IS A SERVER COMPONENT ──────────────────────────────────
 * Token verification needs your App Secret. A secret must NEVER reach the
 * browser bundle, so the HMAC check runs here, on the server, and only the
 * *result* ({ ok, reason }) is handed to the client child. The client half
 * lives in ./EmbedBlockClient.tsx and does the postMessage bridge work, which
 * genuinely must run in the browser.
 *
 * Do not add 'use client' to this file, and do not move verifySignedToken()
 * into the client component — either change ships your App Secret to every
 * storefront visitor.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { EmbedBlockClient } from './EmbedBlockClient';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a signed storefront token using the EmbedBlockTester contract.
 *
 * Server-only. The App Secret is read from FLASHMANDU_APP_SECRET, which must
 * NOT carry the NEXT_PUBLIC_ prefix — that prefix would inline the value into
 * the client bundle.
 */
function verifySignedToken(rawToken: string, secret: string): VerifyResult {
  const parts = rawToken.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [body, sig] = parts;

  let payload: Record<string, string>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return { ok: false, reason: 'payload_decode' };
  }

  // Rebuild the sorted query from the decoded payload and re-sign.
  const sortedQuery = Object.keys(payload)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(payload[k]))}`)
    .join('&');

  const expected = createHmac('sha256', secret)
    .update(body + sortedQuery)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true };
}

export default function EmbedBlockPage({ params, searchParams }: {
  params: { type: string };
  searchParams: Record<string, string | string[] | undefined>;
}): JSX.Element {
  const token = typeof searchParams.session_token === 'string' ? searchParams.session_token : '';
  const secret = process.env.FLASHMANDU_APP_SECRET ?? '';

  let verify: VerifyResult | null = null;
  if (token !== '' && secret !== '') {
    verify = verifySignedToken(token, secret);
  } else if (token !== '') {
    // No secret configured (local dev). Skip the defense-in-depth check and
    // rely on the host bridge identity postMessage, which is the primary
    // trust boundary. Set FLASHMANDU_APP_SECRET to enable this check.
    verify = { ok: false, reason: 'secret_not_configured' };
  }

  return <EmbedBlockClient type={params.type} verify={verify} />;
}
