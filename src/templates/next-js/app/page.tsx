import { FlashmanduClient } from '@/lib/flashmandu';

/**
 * Landing page. In production this is the app's admin UI; in dev it doubles as
 * a sanity check that the sandbox credentials round-trip against /api/apps/me.
 */
export default async function Page() {
  let me: Awaited<ReturnType<FlashmanduClient['me']>> | null = null;
  let error: string | null = null;

  try {
    me = await new FlashmanduClient().me();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <h1>Flashmandu App</h1>
      <p>This is a starter app. Wire your UI here.</p>

      {error && (
        <p style={{ color: 'crimson' }}>
          Could not reach the dev-box <code>/api/apps/me</code>: {error}
        </p>
      )}

      {me && (
        <ul>
          <li>App ID: {me.app_id}</li>
          <li>Name: {me.name}</li>
          <li>Profile: {me.profile_id}</li>
          <li>Scopes: {me.scopes.join(', ') || '(none)'}</li>
          <li>Events: {me.subscribed_events.join(', ') || '(none)'}</li>
        </ul>
      )}
    </main>
  );
}
