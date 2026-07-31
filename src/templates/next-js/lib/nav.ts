'use client';

/**
 * App navigation config — the single place this app's chrome is described.
 *
 * `createAppShell` turns this into Next-wired `PageShell` and `AppTabs`
 * components: the active tab and the breadcrumb trail are both derived from
 * the current route, so pages only pass a title.
 *
 * This module must be marked 'use client': createAppShell BUILDS the
 * components at call time, so the factory has to run inside the client graph.
 * Server Components can still import `PageShell` from here — that is just an
 * ordinary server → client boundary crossing.
 *
 * Breadcrumb keys are path patterns using Next's dynamic-segment syntax, so
 * `/items/[id]` would match `/items/42` and pass "42" to a resolver.
 */

import { createAppShell } from '@flashmandu/app-bridge-ui/next';
import { useBridgeTitle } from '@flashmandu/app-bridge/react';

export const { PageShell, AppTabs } = createAppShell({
  tabs: [
    { key: 'home', href: '/', label: 'Home' },
    { key: 'settings', href: '/settings', label: 'Settings' },
  ],
  breadcrumbs: {
    '/settings': 'Settings',
  },
  // Publishes the page title to the host shell (browser tab + embed header).
  useTitle: useBridgeTitle,
});
