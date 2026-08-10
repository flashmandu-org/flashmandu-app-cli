import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Reader for the per-app sandbox secrets file `autohisab-business dev` writes
 * (`.flashmandu/sandbox-secrets.<publisher>-<slug>.json`, 0600, gitignored).
 *
 * Commands that must authenticate AS THE APP — delivery history, replay —
 * need the app's own api_token: the developer login token resolves to the
 * `dev/cli` app, not theirs.
 */

const SANDBOX_DIR = '.flashmandu';

export interface SandboxIdentity {
  token?: string;
  appId?: string;
}

/**
 * Locate the app's api_token. The filename is keyed by the canonical
 * `<publisher>/<slug>` app id the host returns at register time, which a
 * command cannot know without registering — so scan the directory (there is
 * normally exactly one file per app) and fall back to the manifest slug.
 */
export async function readSandboxIdentity(
  appDir: string,
  slug: string,
): Promise<SandboxIdentity> {
  const dir = path.join(appDir, SANDBOX_DIR);
  const candidates: string[] = [];
  try {
    for (const entry of await fs.readdir(dir)) {
      if (entry.startsWith('sandbox-secrets.') && entry.endsWith('.json')) {
        candidates.push(path.join(dir, entry));
      }
    }
  } catch {
    /* dir missing — fall through to the slug-based path */
  }
  candidates.push(path.join(dir, `sandbox-secrets.${slug}.json`));

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
        api_token?: unknown;
        app_id?: unknown;
      };
      if (typeof parsed.api_token === 'string' && parsed.api_token !== '') {
        return {
          token: parsed.api_token,
          appId: typeof parsed.app_id === 'string' ? parsed.app_id : undefined,
        };
      }
    } catch {
      /* try next */
    }
  }

  return {};
}
