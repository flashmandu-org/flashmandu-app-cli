'use client';

/**
 * Client half of the App Embed Block reference route.
 *
 * Everything here runs in the browser inside the storefront's sandboxed
 * <iframe>. It owns the postMessage bridge handshake and the block's own
 * interactive UI.
 *
 * SECURITY: this file must never touch your App Secret. Token verification is
 * done on the server in ./page.tsx; this component receives only the boolean
 * outcome. If you need another secret-dependent check, add it to the server
 * component and pass the result down — never read a non-NEXT_PUBLIC_ env var
 * from a client component and never import node:crypto here.
 *
 * Capabilities available to a storefront block come ONLY from the
 * [identity, resize, navigate, error] allowlist, and only those the block
 * declared in its manifest. profile_id is NEVER sent to storefront blocks.
 */

import { useEffect, useState } from 'react';
import { createAppBridge, type AppContext } from '@flashmandu/app-bridge';
import type { VerifyResult } from './page';

type StorefrontContext = AppContext & {
  /** Opaque per-instance id (the page-builder node id). Stable within a page. */
  instance_id?: string;
  /** Pseudonymous visitor id. profile_id is NEVER sent to storefront blocks. */
  visitor_id?: string;
};

export function EmbedBlockClient({ type, verify }: {
  type: string;
  verify: VerifyResult | null;
}): JSX.Element {
  const [ctx, setCtx] = useState<StorefrontContext | null>(null);
  const [standalone, setStandalone] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  return (
    <div className="app-embed-shell">
      <div className="fm-card">
        <h2 className="fm-card__title">Embed Block: {type}</h2>

        {standalone ? (
          <p className="fm-muted">{standalone}</p>
        ) : ctx ? (
          <dl className="fm-kv">
            <dt>app_id</dt>
            <dd>{ctx.appId ?? '—'}</dd>
            <dt>instance_id</dt>
            <dd>{ctx.instance_id ?? '—'}</dd>
            <dt>visitor_id</dt>
            <dd>{ctx.visitor_id ?? '—'}</dd>
            <dt>locale</dt>
            <dd>{ctx.locale ?? '—'}</dd>
          </dl>
        ) : (
          <p className="fm-muted">
            <span className="fm-spinner fm-spinner--sm" /> Connecting to storefront bridge…
          </p>
        )}

        {verify !== null && (
          <p className={verify.ok ? 'fm-badge fm-badge--success' : 'fm-badge fm-badge--warning'}>
            {verify.ok ? 'token verified' : `token unverified: ${verify.reason}`}
          </p>
        )}
      </div>

      <div className="fm-card">
        <CounterControl />
      </div>
    </div>
  );
}

/** A trivial interactive control to prove the block is alive in the sandbox. */
function CounterControl(): JSX.Element {
  const [n, setN] = useState(0);

  return (
    <button type="button" className="fm-btn fm-btn--sm" onClick={() => setN((v) => v + 1)}>
      Clicked {n} times
    </button>
  );
}
