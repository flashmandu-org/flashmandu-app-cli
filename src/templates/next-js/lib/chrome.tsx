'use client';

/**
 * `AppPage` — the ONE way this template declares page chrome.
 *
 * Doctrine (parity spec §5): an embedded app renders NO desktop heading of its
 * own. Breadcrumbs, page actions and the dirty ⇄ Save/Discard swap all live in
 * the HOST's command bar, and the app publishes them over the bridge with
 * `usePageChrome`. There is no `PageHeader` here on purpose — an in-page title
 * bar is exactly what makes an embed look bolted-on.
 *
 * On narrow viewports the host command bar is not visible, so `MobilePageHeader`
 * renders the same title/actions inside the iframe. It is `lg:hidden` by
 * construction (the `fm-mobile-page-header` class), so the two never both show.
 */

import type { ReactNode } from 'react';
import { usePageChrome, type PageChromeAction } from '@flashmandu/app-bridge/react';
import type { PageCrumb } from '@flashmandu/app-bridge';
import { Container, MobilePageHeader } from '@flashmandu/app-bridge-ui/react';

export interface AppPageProps {
  /** Document-title suffix + mobile heading. Never rendered on desktop. */
  title: string;
  /** Optional one-liner under the mobile heading. */
  subtitle?: string;
  /**
   * Breadcrumb trail, current page last. Max 5 — the host truncates beyond
   * that rather than wrapping the command bar.
   */
  crumbs?: PageCrumb[];
  /** Command-bar buttons. Max 4; each carries its own handler. */
  actions?: PageChromeAction[];
  /** Unsaved changes: the host swaps its bar for native Save/Discard. */
  dirty?: boolean;
  children: ReactNode;
}

export function AppPage({
  title,
  subtitle,
  crumbs,
  actions,
  dirty = false,
  children,
}: AppPageProps) {
  usePageChrome({ title, crumbs, actions, dirty });

  return (
    <Container>
      <MobilePageHeader
        title={title}
        subtitle={subtitle}
        actions={actions?.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`fm-btn ${action.variant === 'primary' ? 'fm-btn--primary' : 'fm-btn--subtle'}`}
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        ))}
      />
      {children}
    </Container>
  );
}
