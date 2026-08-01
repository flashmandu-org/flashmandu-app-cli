export type HostingTarget = 'vercel' | 'self';

export interface DerivedUrls {
  authorize_url: string;
  token_url: string;
  webhook_url: string;
}

/**
 * The three endpoints the starter template serves, derived from one base URL
 * so a developer supplies their host once instead of three near-identical
 * URLs they can typo independently.
 */
export function deriveUrls(baseUrl: string): DerivedUrls {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');

  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error(`Base URL must start with https:// — got "${baseUrl}".`);
  }

  return {
    authorize_url: `${trimmed}/oauth/authorize`,
    token_url: `${trimmed}/oauth/token`,
    webhook_url: `${trimmed}/webhooks/flashmandu`,
  };
}
