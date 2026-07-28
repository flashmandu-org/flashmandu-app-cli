import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FlashmanduClient } from '@/lib/flashmandu';
import { BridgeContext } from './_components/BridgeContext';

interface WebhookEntry {
  at?: string;
  event?: string;
  delivery_id?: string;
  payload?: unknown;
}

/**
 * Reads the most recent webhook deliveries from `.flashmandu/webhooks.log`,
 * the same file the PHP template writes. One JSON object per line.
 * Returns an empty list when the file does not exist yet (no deliveries).
 */
function readRecentWebhooks(limit = 20): WebhookEntry[] {
  try {
    const file = path.join(process.cwd(), '.flashmandu', 'webhooks.log');
    const raw = readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line !== '')
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as WebhookEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is WebhookEntry => entry !== null)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Landing page. In production this is the app's admin UI; in dev it doubles as
 * a sanity check that the sandbox credentials round-trip against /api/apps/me
 * and that the App Bridge resolves once embedded.
 */
export default async function Page() {
  let me: Awaited<ReturnType<FlashmanduClient['me']>> | null = null;
  let error: string | null = null;

  try {
    me = await new FlashmanduClient().me();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const events = readRecentWebhooks();
  const appName = me?.name ?? 'Flashmandu App';

  return (
    <main className="fm-app-shell">
      <div className="fm-container">
        <header className="fm-app-header">
          <h1 className="fm-app-title">⚡ {appName}</h1>
          <nav className="fm-nav" aria-label="Primary">
            <a href="/">Home</a>
            <a href="/oauth/authorize">Install</a>
            <a
              href="https://github.com/flashmandu-org"
              target="_blank"
              rel="noreferrer"
            >
              Docs
            </a>
          </nav>
        </header>

        <section className="fm-card">
          <h2>App Bridge context</h2>
          <BridgeContext />
        </section>

        <section className="fm-card">
          <h2>Dev-box identity</h2>
          {error && (
            <p className="fm-muted">
              Could not reach the dev-box <code>/api/apps/me</code>: {error}
            </p>
          )}
          {!error && !me && <p className="fm-muted">Loading…</p>}
          {me && (
            <dl className="fm-kv">
              <dt>App ID</dt>
              <dd>{me.app_id}</dd>
              <dt>Name</dt>
              <dd>{me.name}</dd>
              <dt>Profile</dt>
              <dd>{me.profile_id}</dd>
              <dt>Scopes</dt>
              <dd>
                {me.scopes.length ? (
                  me.scopes.map((s) => (
                    <span key={s} className="fm-chip">
                      {s}
                    </span>
                  ))
                ) : (
                  <span className="fm-muted">(none)</span>
                )}
              </dd>
              <dt>Events</dt>
              <dd>
                {me.subscribed_events.length ? (
                  me.subscribed_events.map((s) => (
                    <span key={s} className="fm-chip">
                      {s}
                    </span>
                  ))
                ) : (
                  <span className="fm-muted">(none)</span>
                )}
              </dd>
            </dl>
          )}
        </section>

        <section className="fm-card">
          <h2>Recent webhook events</h2>
          {events.length === 0 ? (
            <p className="fm-muted">
              No webhooks received yet. Deliveries will be listed here once they
              arrive.
            </p>
          ) : (
            <ul className="fm-events">
              {events.map((entry, i) => (
                <li
                  key={`${entry.delivery_id ?? ''}-${i}`}
                  className="fm-event"
                >
                  <time>{entry.at ?? '—'}</time>
                  <span className="name">{entry.event ?? '(unknown)'}</span>
                  <code>{entry.delivery_id?.slice(0, 8) ?? ''}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
