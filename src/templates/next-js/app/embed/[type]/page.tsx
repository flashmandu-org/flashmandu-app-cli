'use client';

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
 * The signed token (Slice 1 EmbedBlockTester contract) is:
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
 * In production the host (storefront App Bridge) posts the signed identity
 * context to this iframe over postMessage; we verify the signed token here as a
 * defense-in-depth check that the load really came from the platform.
 */

import { useEffect, useMemo, useState } from 'react';
import { createAppBridge, type AppContext } from '@flashmandu/app-bridge';

type StorefrontContext = AppContext & {
  /** Opaque per-instance id (the page-builder node id). Stable within a page. */
  instance_id?: string;
  /** Pseudonymous visitor id. profile_id is NEVER sent to storefront blocks. */
  visitor_id?: string;
};

type VerifyResult =
  | { ok: true; payload: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Verify a signed storefront token using the EmbedBlockTester contract.
 * Returns the decoded payload on success; the App Secret is read from the
 * FLASHMANDU_APP_SECRET env var (server-side only in a real deployment; this
 * reference route is client-rendered so the secret must be injected at build /
 * via the host bridge in production — never shipped to the browser for real
 * apps). The local EmbedBlockTester mints tokens with the same secret.
 */
function verifySignedToken(rawToken: string, secret: string): VerifyResult {
  const parts = rawToken.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [body, sig] = parts;

  // Rebuild the sorted query from the decoded payload and re-sign.
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return { ok: false, reason: 'payload_decode' };
  }

  const sortedQuery = Object.keys(payload)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(payload[k]))}`)
    .join('&');

  const crypto = require('node:crypto') as typeof import('node:crypto');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body + sortedQuery)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, payload };
}

export default function EmbedBlockPage({ params, searchParams }: {
  params: { type: string };
  searchParams: Record<string, string | string[] | undefined>;
}): JSX.Element {
  const type = params.type;
  const token = typeof searchParams.session_token === 'string' ? searchParams.session_token : '';

  const [ctx, setCtx] = useState<StorefrontContext | null>(null);
  const [standalone, setStandalone] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  const secret = useMemo(() => process.env.FLASHMANDU_APP_SECRET ?? '', []);

  useEffect(() => {
    // Defense-in-depth: verify the signed token from the URL.
    if (token && secret) {
      setVerify(verifySignedToken(token, secret));
    } else if (token) {
      // No secret available (e.g. pure browser context). Skip local verify and
      // rely on the host bridge identity postMessage.
      setVerify({ ok: true, payload: { session_token: token } });
    }

    // Standalone (not in an iframe) -> show a friendly dev placeholder.
    if (window.self === window.top) {
      setStandalone('This block loads inside the storefront iframe. Local preview only.');
      return;
    }

    const bridge = createAppBridge();
    let cancelled = false;
    bridge.ready().then((c: AppContext) => {
      if (!cancelled) {
        setCtx(c as StorefrontContext);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [token, secret]);

  return (
    <div className="fm-app-shell" style={{ minHeight: '100%' }}>
      <div className="fm-card">
        <h2 className="fm-kv">Embed Block: {type}</h2>

        {standalone ? (
          <p className="fm-muted">{standalone}</p>
        ) : ctx ? (
          <ul className="fm-kv">
            <li>app_id: {ctx.appId}</li>
            <li>instance_id: {ctx.instance_id ?? '—'}</li>
            <li>visitor_id: {ctx.visitor_id ?? '—'}</li>
            <li>locale: {ctx.locale ?? '—'}</li>
          </ul>
        ) : (
          <p className="fm-muted">Connecting to storefront bridge…</p>
        )}

        <p className="fm-chip">
          {verify?.ok
            ? `verified token (${verify.reason === 'bad_signature' ? '' : 'ok'})`
            : `token rejected: ${verify?.reason ?? 'pending'}`}
        </p>
      </div>

      {/*
        A trivial interactive control to prove the block is alive in the sandbox.
        Capabilities granted here come ONLY from the [identity, resize, navigate,
        error] allowlist AND only those the block declared (spec §7).
      */}
      <div className="fm-card" style={{ marginTop: 12 }}>
        <CounterControl />
      </div>
    </div>
  );
}

function CounterControl(): JSX.Element {
  const [n, setN] = useState(0);
  return (
    <button className="fm-chip" onClick={() => setN((v) => v + 1)}>
      Clicked {n} times
    </button>
  );
}
