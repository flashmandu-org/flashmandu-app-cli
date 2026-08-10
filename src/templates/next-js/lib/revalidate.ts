import { loadConfig } from './config';

/**
 * Platform cache revalidation.
 *
 * The platform caches embed-block data derived from THIS app's rows — the
 * block picker markup in the page builder and the dynamic-options payloads
 * behind block dropdowns. After any mutation to the data your blocks render,
 * tell the platform to drop those caches or the builder keeps showing stale
 * choices for the cache TTL.
 *
 * Call this from your server actions / route handlers after every create,
 * update, or delete that affects block content or options:
 *
 *   await purgePlatformEmbedCaches();
 *
 * Fire-and-forget by design: a failed purge must never fail the merchant's
 * own save — the platform TTLs are the safety net.
 */
export async function purgePlatformEmbedCaches(profileId?: number): Promise<void> {
  try {
    const { apiToken, devBoxBaseUrl } = loadConfig();

    if (devBoxBaseUrl === '') {
      return;
    }

    await fetch(`${devBoxBaseUrl}/api/apps/embed/revalidate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      // One platform-hosted pod serves every installing profile with a shared
      // credential, so name the profile that was just mutated — the platform
      // purges that profile's caches (verified against its install rows).
      body: JSON.stringify(profileId ? { profile_id: profileId } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Intentionally swallowed — see docblock.
  }
}
