'use client';

/**
 * Settings — the form-page example.
 *
 * Every page with form fields is a `<FormPage>` (GUIDELINES §2.5). It
 * publishes Save (primary) + Cancel to the host command bar — Save disabled
 * while the form is pristine, spinning while `onSubmit`'s promise is pending —
 * renders a real <form> so Enter saves, and warns on tab close while dirty.
 * The host hides ⌘K while `dirty`. Never draw a Save button of your own;
 * `autohisab-business doctor` fails a page that does (form-actions-in-command-bar).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Card, Field, FormPage, Input } from '@flashmandu/app-bridge-ui/react';
import { BridgeContext } from '@flashmandu/app-bridge/react';

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const dirty = name !== saved;

  // Replace with a call to your own backend.
  const save = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        setSaved(name);
        resolve();
      }, 400);
    });

  return (
    <FormPage
      title="Settings"
      subtitle="App-level configuration."
      crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Settings' }]}
      linkComponent={Link}
      dirty={dirty}
      onSubmit={save}
      cancelLabel="Discard"
      onCancel={() => setName(saved)}
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
    </FormPage>
  );
}
