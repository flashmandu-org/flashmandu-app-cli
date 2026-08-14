/* @flashmandu-template app/layout.tsx@0.4.0 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// index.css is imported by globals.css — keep the styling entry point in one
// place so override order stays predictable.
import './globals.css';
import { BridgeBootstrap, usePageChrome } from '@flashmandu/app-bridge/react';
import { UrlSync } from '@flashmandu/app-bridge/next';
import { configurePageChrome, type PageChromeHook } from '@flashmandu/app-bridge-ui/react';

// Teach `<Page>` (used throughout app/) how to reach the host, once, at
// module scope — two callers of `usePageChrome` would fight over SET_PAGE
// and the loser's title would win at random.
//
// The cast below works around a cross-package type mismatch in the SDK as
// currently vendored (0.4.0): @flashmandu/app-bridge's `PageChromeAction`
// types `variant` as required with `'ghost'`, while
// @flashmandu/app-bridge-ui's own `PageAction` types it as optional with
// `'default'`. The wiring itself is exactly what the kit's GUIDELINES.md
// documents; only the mismatched parameter type is cast, so a real signature
// change to `usePageChrome` still fails to compile here.
configurePageChrome(usePageChrome as unknown as PageChromeHook);

export const metadata: Metadata = {
  title: 'Flashmandu App',
  description: 'Flashmandu storefront app (Next.js template).',
};

/**
 * Root layout.
 *
 * `BridgeBootstrap` performs the postMessage handshake with the host shell;
 * `UrlSync` mirrors in-app navigation into the platform's address bar so deep
 * links and the browser back button work inside the embed iframe.
 *
 * THEMING: no `data-fm-theme` is set here, on purpose. Since bridge 0.4.0 the
 * token layer falls back to LIGHT when no host signal is present — the host's
 * embed shell always appends the real theme on the URL fragment, so the
 * fallback only ever fires for a standalone `npm run dev` tab, where matching
 * the light-first product beats matching the developer's own OS (that used to
 * be `prefers-color-scheme`, which is how a dark-mode laptop turned into
 * hardcoded dark styles that shipped to every merchant). OS-following is
 * opt-in only, for an app that deliberately wants it in standalone dev:
 *
 *     <html lang="en" data-fm-theme-follow-system>
 *
 * Do not hardcode `data-fm-theme="light"` or `"dark"` here — `doctor`'s
 * `no-theme-pin` rule fails on it, and a pin blocks merchant dark mode.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <BridgeBootstrap />
        <UrlSync />
        {children}
      </body>
    </html>
  );
}
