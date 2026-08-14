/* @flashmandu-template app/layout.tsx@0.4.0 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// index.css is imported by globals.css — keep the styling entry point in one
// place so override order stays predictable.
import './globals.css';
import { BridgeBootstrap } from '@flashmandu/app-bridge/react';
import { UrlSync } from '@flashmandu/app-bridge/next';
import { PageChromeSetup } from './PageChromeSetup';

// `<Page>` (used throughout app/) is taught how to reach the host by
// `PageChromeSetup`. That wiring MUST run from a `'use client'` module, not
// here: this file is a Server Component, and `usePageChrome` /
// `configurePageChrome` are both exported from `'use client'`-marked SDK
// entry points. Calling them directly at Server Component module scope
// resolves to RSC client-reference proxies, not the real functions, and
// fails `next build`'s page-data collection with a minified
// `TypeError: ... is not a function`. See PageChromeSetup.tsx for the full
// explanation. Render it as an element below — never import and call its
// exports here.

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
        <PageChromeSetup />
        <BridgeBootstrap />
        <UrlSync />
        {children}
      </body>
    </html>
  );
}
