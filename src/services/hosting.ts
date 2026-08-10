export type HostingTarget = 'vercel' | 'self' | 'platform';

export interface DerivedUrls {
  authorize_url: string;
  token_url: string;
  webhook_url: string;
}

export interface DeriveOptions {
  target?: HostingTarget;
  /** Leaf of `<publisher>/<slug>` — required when target is 'platform'. */
  slug?: string;
  /** Hostname (or base URL) of the AutoHisab Business platform — required for 'platform'. */
  platformHost?: string;
}

/**
 * The three endpoints the starter template serves, derived from one base URL
 * so a developer supplies their host once instead of three near-identical
 * URLs they can typo independently.
 *
 * For `platform` hosting the base URL is NOT developer-supplied: the app runs
 * on the platform's runtime, so its URLs live on the platform's own hostname
 * scheme `https://<slug>.apps.<domain>`. A developer-typed base is ignored,
 * which makes a placeholder host impossible by construction.
 */
export function deriveUrls(baseUrl: string, opts: DeriveOptions = {}): DerivedUrls {
  const effective = opts.target === 'platform'
    ? platformBaseUrl(opts.slug ?? '', opts.platformHost ?? '')
    : baseUrl;
  const trimmed = effective.trim().replace(/\/+$/, '');

  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error(`Base URL must start with https:// — got "${effective}".`);
  }

  return {
    authorize_url: `${trimmed}/oauth/authorize`,
    token_url: `${trimmed}/oauth/token`,
    webhook_url: `${trimmed}/webhooks/flashmandu`,
  };
}

/**
 * The platform-assigned base URL for a platform-hosted app. Derived, never
 * typed by the developer.
 */
export function platformBaseUrl(slug: string, platformHost: string): string {
  const host = platformHost
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/].*$/, '')
    .replace(/:+$/, '');

  if (!slug) {
    throw new Error('A slug is required to derive the platform app URL.');
  }
  if (!host) {
    throw new Error('The platform host is required to derive the platform app URL.');
  }

  return `https://${slug}.apps.${host}`;
}
