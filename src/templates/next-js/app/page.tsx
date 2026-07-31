import Link from 'next/link';
import { Card, Section, Stat, StatGrid } from '@flashmandu/app-bridge-ui/react';
import { PageShell } from '@/lib/nav';

export default function Page() {
  return (
    <PageShell
      title="Dashboard"
      subtitle="Welcome to your Flashmandu app."
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
        <Card title="Quick start" subtitle="Build your first feature">
          <p className="fm-muted" style={{ margin: 0 }}>
            This is your app's dashboard. Use the components from
            <code> @flashmandu/app-bridge-ui/react</code> to build your UI —
            buttons, cards, tables, forms, and more.
          </p>
        </Card>

        <Card title="App Bridge" subtitle="Embedded context" accent="blue">
          <p className="fm-muted" style={{ margin: 0 }}>
            When embedded in the Flashmandu platform, the App Bridge resolves
            your session context (profile ID, scopes, locale). Visit the
            Settings page to see the live bridge context.
          </p>
        </Card>

        <Card title="Webhooks" subtitle="HMAC-verified events" accent="green">
          <p className="fm-muted" style={{ margin: 0 }}>
            Webhook deliveries are verified via HMAC. The webhook handler is at
            <code> /webhooks/flashmandu</code>. Subscribe to events in your
            <code> flashmandu.app.toml</code>.
          </p>
        </Card>
      </Section>
    </PageShell>
  );
}
