/**
 * Minimal Flashmandu API client for the app template. The host exposes:
 *
 *   GET  /api/apps/me         — identity of the installed app (Bearer token)
 *   GET  /api/apps/hooks      — public hook catalog
 *
 * The dev-box base URL comes from FLASHMANDU_DEV_BOX_BASE_URL. The token is
 * the one issued once at install/dev-register time.
 *
 * This client is intentionally framework-free (fetch only) so it can be lifted
 * into any runtime.
 */

import { loadConfig, type FlashmanduConfig } from './config';

export class FlashmanduClient {
  private readonly cfg: FlashmanduConfig;

  constructor(config?: FlashmanduConfig) {
    this.cfg = config ?? loadConfig();
  }

  private async request<T>(p: string, init: RequestInit = {}): Promise<T> {
    if (!this.cfg.devBoxBaseUrl) {
      throw new Error('FLASHMANDU_DEV_BOX_BASE_URL is not set.');
    }
    const res = await fetch(`${this.cfg.devBoxBaseUrl}${p}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.cfg.apiToken}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Flashmandu API ${res.status} ${res.statusText}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET /api/apps/me — verify the install + read scopes. */
  me(): Promise<{
    app_id: string;
    name: string;
    profile_id: number;
    scopes: string[];
    subscribed_events: string[];
  }> {
    return this.request('/api/apps/me');
  }

  /** GET /api/apps/hooks — public hook catalog (no auth needed). */
  hooks(): Promise<Record<string, { description: string; category: string; type?: string }>> {
    return this.request('/api/apps/hooks');
  }
}
