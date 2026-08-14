'use client';

/**
 * Settings — a dirty-state example.
 *
 * When `dirty` is true the host swaps its command bar for the NATIVE Save /
 * Discard pair, so an app never draws its own save button on desktop. The two
 * actions still arrive here by id, through the same `onSelect` handlers.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Card, Field, Input, Page } from '@flashmandu/app-bridge-ui/react';
import { BridgeContext } from '@flashmandu/app-bridge/react';

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = name !== saved;

  return (
    <Page
      title="Settings"
      subtitle="App-level configuration."
      crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Settings' }]}
      dirty={dirty}
      linkComponent={Link}
      actions={[
        {
          id: 'save',
          label: 'Save',
          variant: 'primary',
          loading: saving,
          disabled: !dirty,
          onSelect: () => {
            setSaving(true);
            // Replace with a call to your own backend.
            setTimeout(() => {
              setSaved(name);
              setSaving(false);
            }, 400);
          },
        },
        { id: 'discard', label: 'Discard', variant: 'default', onSelect: () => setName(saved) },
      ]}
    >
      <Card title="General">
        <Field label="Display name" hint="Shown to merchants inside your app.">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
      </Card>

      <Card title="App Bridge context">
        <BridgeContext />
      </Card>

      <Card title="Secrets">
        <p className="fm-muted" style={{ margin: 0 }}>
          API keys and third-party credentials belong in hosted secrets, not in
          settings: <code>autohisab-business config set STRIPE_KEY=…</code>.
          They are encrypted at rest, injected as env vars on deploy, and never
          readable back — <code>config list</code> shows key names only.
        </p>
      </Card>
    </Page>
  );
}
