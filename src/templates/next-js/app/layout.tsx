import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// tokens.css + components.css are imported by globals.css — keep the styling
// entry point in one place so override order stays predictable.
import './globals.css';
import { BridgeBootstrap } from '@flashmandu/app-bridge/react';
import { UrlSync } from '@flashmandu/app-bridge/next';

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
 * THEMING: no `data-fm-theme` is set here, on purpose. Left unset, the token
 * layer follows `prefers-color-scheme`, so the app matches the merchant's
 * theme out of the box. Pin it only if your app is deliberately single-theme:
 *
 *     <html lang="en" data-fm-theme="light">
 *
 * Hardcoding it is the easiest way to ship an app that looks broken to every
 * dark-mode merchant.
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
