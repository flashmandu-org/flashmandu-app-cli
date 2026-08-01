/** Hosts the starter template ships, which can never serve a real install. */
const PLACEHOLDER_HOSTS = new Set(['app-host', 'localhost', '127.0.0.1', '[::1]']);

/**
 * The template ships `https://APP-HOST/...`. Pushing those produced an app
 * that listed fine and then dead-ended at ERR_NAME_NOT_RESOLVED in the
 * merchant's browser, so `push` refuses them before contacting the platform.
 */
export function isPlaceholderUrl(url: string): boolean {
  let host: string;

  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return true;
  }

  return host === '' || PLACEHOLDER_HOSTS.has(host) || host.endsWith('.example');
}

/**
 * Best-effort reachability probe. Any HTTP response is a pass — a 400 from an
 * OAuth endpoint called without params still proves the host is real.
 */
export async function probeUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  if (isPlaceholderUrl(url)) {
    return { ok: false, error: `${url} is a placeholder host.` };
  }

  try {
    await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${url} is unreachable: ${(err as Error).message}` };
  }
}
