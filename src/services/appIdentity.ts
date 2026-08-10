import type { AppManifest } from './manifest';
import { readSandboxIdentity } from './sandboxSecrets';

/**
 * Resolution of the canonical `<publisher>/<slug>` app id from the developer's
 * side. The platform is the authority — it namespaces the slug by the
 * publisher handle of the logged-in user — but several commands need the id
 * BEFORE any round-trip (hosted secrets, platform logs).
 */

/**
 * Mirror of the platform's publisher-handle derivation
 * (`AppManager::publisherHandle` with no username): email local-part,
 * lowercased, non-alphanumerics collapsed to dashes.
 */
export function publisherHandleFromEmail(email: string | undefined): string {
  const raw = (email ?? '').split('@')[0] ?? '';
  const handle = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!handle) {
    throw new Error(
      'Cannot derive a publisher handle — set developer_email in flashmandu.app.toml first.',
    );
  }

  return handle;
}

/**
 * The canonical app id for this directory. Prefers the id the host handed back
 * at `dev` register time (authoritative); falls back to deriving it from the
 * manifest's developer_email.
 */
export async function resolveAppId(appDir: string, manifest: AppManifest): Promise<string> {
  const { appId } = await readSandboxIdentity(appDir, manifest.slug);
  if (appId) return appId;
  return `${publisherHandleFromEmail(manifest.developer_email)}/${manifest.slug}`;
}
