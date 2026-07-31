import { Card } from '@flashmandu/app-bridge-ui/react';
import { PageShell } from '@/lib/nav';
import { BridgeContext } from '@flashmandu/app-bridge/react';

export default async function SettingsPage() {
  return (
    <PageShell
      title="Settings"
      subtitle="App-level configuration."
      back={{ href: '/', label: 'Back to Home' }}
    >
      <Card title="Settings">
        <p className="fm-muted" style={{ margin: 0 }}>
          This is a placeholder settings surface — per-app preferences, feature
          flags, and embed-block defaults will land here.
        </p>
      </Card>

      <Card title="App Bridge context">
        <BridgeContext />
      </Card>
    </PageShell>
  );
}
