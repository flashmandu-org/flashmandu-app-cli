/* @flashmandu-template app/PageChromeSetup.tsx@0.4.1 */
'use client';

/**
 * Wires `<Page>` (bridge-ui) to `usePageChrome` (bridge), once, at module
 * scope — two callers of `usePageChrome` would fight over SET_PAGE and the
 * loser's title would win at random.
 *
 * WHY THIS IS ITS OWN CLIENT FILE, NOT INLINE IN `app/layout.tsx`:
 * `usePageChrome` (`@flashmandu/app-bridge/react`) and `configurePageChrome`
 * (`@flashmandu/app-bridge-ui/react`) both come from `'use client'`-marked
 * entry points. `app/layout.tsx` is a Server Component, so importing them
 * there does not hand you the real functions — Next.js's RSC compiler swaps
 * every export of a client-boundary module for an opaque client-reference
 * proxy when a Server Component imports it (the mechanism that lets the
 * export be *rendered* as `<Component />` later on the client). Calling that
 * proxy directly, as a plain function, at Server Component module scope
 * (`configurePageChrome(usePageChrome)`) is not a supported operation on the
 * proxy — it fails page-data collection with a minified
 * `TypeError: o is not a function`, since the proxy is a marker object for
 * JSX, not the real `configurePageChrome`.
 *
 * Doing the same call at the top of a `'use client'` module sidesteps this
 * entirely: within a client module's own graph there is no server/client
 * boundary to cross, so `usePageChrome` and `configurePageChrome` resolve to
 * their real implementations for both the SSR pass and the browser bundle.
 * `app/layout.tsx` only ever reaches this code by rendering `<PageChromeSetup />`
 * as an element — never by calling an export directly — which is the
 * supported way for a Server Component to pull in client behavior.
 *
 * No cast is needed here: app-bridge 0.4.2 / app-bridge-ui 0.4.1 unified the
 * action `variant` contract (optional, identical union, `'default'`
 * normalised to `'ghost'` before the wire), so `configurePageChrome(usePageChrome)`
 * type-checks directly against the pinned SDK versions.
 */

import { usePageChrome } from '@flashmandu/app-bridge/react';
import { configurePageChrome } from '@flashmandu/app-bridge-ui/react';

configurePageChrome(usePageChrome);

/** Renders nothing; imported purely so `app/layout.tsx` can mount it as a client element. */
export function PageChromeSetup(): null {
  return null;
}
