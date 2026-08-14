'use client';

import Link from 'next/link';
import { Card, Page, Section, Stat, StatGrid } from '@flashmandu/app-bridge-ui/react';

/**
 * Dashboard.
 *
 * Note what is NOT here: no page heading, no in-app title bar. The breadcrumb
 * and the "New item" button below are published to the HOST command bar by
 * `Page` → `usePageChrome`, which is what makes the embed read as a native
 * page instead of a website inside a box.
 */
export default function DashboardPage() {
  return (
    <Page
      title="Dashboard"
      subtitle="Welcome to your AutoHisab Business app."
      crumbs={[{ label: 'Dashboard' }]}
      linkComponent={Link}
      actions={[
        {
          id: 'new-item',
          label: 'New item',
          variant: 'primary',
          onSelect: () => {
            window.location.href = '/items';
          },
        },
      ]}
    >
      <StatGrid>
        <Stat label="Status" value="Active" />
        <Stat label="Plan" value="Free" />
        <Stat label="Events" value="0" />
        <Stat label="Webhooks" value="0" />
      </StatGrid>

      <Section
        title="Getting started"
        action={
          <Link href="/settings" className="fm-btn fm-btn--subtle">
            Settings
          </Link>
        }
      >
        <Card title="Page chrome" subtitle="Declared, not drawn">
          <p className="fm-muted" style={{ margin: 0 }}>
            Call <code>usePageChrome</code> (via <code>Page</code>) with your
            breadcrumbs, actions and dirty flag. The host renders them in its own
            command bar and posts clicks back by action id. Never render a
            desktop <code>&lt;h1&gt;</code> yourself.
          </p>
        </Card>

        <Card title="Tables" subtitle="IndexTable" accent="blue">
          <p className="fm-muted" style={{ margin: 0 }}>
            The <Link href="/items">Items</Link> page shows the standard list
            surface: sortable columns, selection with bulk actions, a pinned
            first column, pagination in the shell footer, and skeleton rows
            while data loads.
          </p>
        </Card>

        <Card title="Webhooks" subtitle="HMAC-verified events" accent="green">
          <p className="fm-muted" style={{ margin: 0 }}>
            Declare subscriptions in the <code>[webhooks]</code> section of
            <code> flashmandu.app.toml</code> (or run
            <code> autohisab-business hooks subscribe &lt;event&gt;</code>); the
            handler lives at <code>/webhooks/flashmandu</code>. Inspect
            deliveries with <code>autohisab-business hooks deliveries</code>.
          </p>
        </Card>
      </Section>
    </Page>
  );
}
