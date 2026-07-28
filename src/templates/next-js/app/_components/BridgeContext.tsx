'use client';

import { useEffect, useState } from 'react';
import { createAppBridge, type AppContext } from '@flashmandu/app-bridge';

/**
 * Resolves the in-iframe App Bridge context and renders it.
 *
 * The App Bridge only resolves when the page is mounted inside the
 * Flashmandu embed iframe — it relies on postMessage with the parent shell.
 * Browsed standalone (e.g. via `npm run dev`), we surface that gracefully
 * rather than showing a perpetual spinner.
 */
type State =
  | { status: 'loading' }
  | { status: 'ready'; ctx: AppContext }
  | { status: 'standalone'; reason: string };

export function BridgeContext() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.self === window.top) {
      setState({
        status: 'standalone',
        reason:
          'Running standalone (not embedded). The App Bridge only resolves inside the Flashmandu embed iframe.',
      });
      return;
    }

    let cancelled = false;
    createAppBridge()
      .ready()
      .then((ctx) => {
        if (!cancelled) setState({ status: 'ready', ctx });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'standalone',
          reason: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <p className="fm-muted">Resolving App Bridge context…</p>;
  }

  if (state.status === 'standalone') {
    return (
      <p className="fm-muted" role="note">
        {state.reason}
      </p>
    );
  }

  const { ctx } = state;
  return (
    <dl className="fm-kv">
      <dt>Origin</dt>
      <dd>{ctx.origin}</dd>
      <dt>App ID</dt>
      <dd>{ctx.appId ?? '—'}</dd>
      <dt>Profile</dt>
      <dd>{ctx.profileId ?? '—'}</dd>
      <dt>Target</dt>
      <dd>{ctx.target ?? '—'}</dd>
      <dt>Locale</dt>
      <dd>{ctx.locale ?? '—'}</dd>
      <dt>Scopes</dt>
      <dd>
        {ctx.scopes.length ? (
          ctx.scopes.map((s) => (
            <span key={s} className="fm-chip">
              {s}
            </span>
          ))
        ) : (
          <span className="fm-muted">(none)</span>
        )}
      </dd>
    </dl>
  );
}
