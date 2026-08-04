import { post } from './apiClient';
import { isPlaceholderUrl } from './verify';
import type { AppManifest } from './manifest';

export interface SubmitResult {
  id: number | string;
  app_id?: string;
}

export interface SubmitOptions {
  /** Manifest version to submit (already bumped by the caller). */
  version: string;
  developerName?: string;
  developerEmail?: string;
  sourceUrl?: string;
  description?: string;
}

export async function submitAppForReview(
  manifest: AppManifest,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const badUrls = (['authorize_url', 'token_url', 'webhook_url'] as const)
    .filter((f) => isPlaceholderUrl(manifest[f] ?? ''));
  if (badUrls.length > 0) {
    throw new Error(
      `Cannot submit: ${badUrls.join(', ')} still hold placeholder host(s). Run \`flashmandu-app deploy\` first.`,
    );
  }

  const developerName = opts.developerName ?? manifest.developer_name;
  const developerEmail = opts.developerEmail ?? manifest.developer_email;
  if (!developerName || !developerEmail) {
    throw new Error(
      'First submission needs developer_name and developer_email. Pass --developer-name / --developer-email once.',
    );
  }

  // Authenticated: the server resolves the developer identity from the bearer
  // token (not the manifest's developer_email, which may be a template
  // placeholder). This is what makes the publisher handle match the logged-in
  // user, not the manifest default.
  return post<SubmitResult>(
    '/api/apps/app-submissions',
    {
      developer_name: developerName,
      developer_email: developerEmail,
      app_id: manifest.slug,
      name: manifest.name,
      provider_class: manifest.provider_class,
      source_url: opts.sourceUrl ?? manifest.source_url,
      description: opts.description ?? manifest.description ?? '',
      authorize_url: manifest.authorize_url,
      token_url: manifest.token_url,
      webhook_url: manifest.webhook_url,
      version: opts.version,
      scopes: manifest.scopes ?? [],
      subscribed_events: manifest.subscribed_events ?? [],
      embed_blocks: manifest.embed_blocks ?? [],
      nav_items: manifest.nav_items ?? [],
    },
  );
}
