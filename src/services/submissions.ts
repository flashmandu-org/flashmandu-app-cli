import { post } from './apiClient';
import { isPlaceholderUrl } from './verify';
import { buildAppConfigSync } from './appSync';
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
  // `[webhooks]` / `[[schedules]]` are synced with the submission — the same
  // declarative surface `dev` registers, so review and runtime never disagree.
  const sync = buildAppConfigSync(manifest);

  const candidates: Array<[string, string]> = [
    ['authorize_url', manifest.authorize_url ?? ''],
    ['token_url', manifest.token_url ?? ''],
    ['webhook_url', sync.webhook_url ?? ''],
  ];
  const badUrls = candidates.filter(([, url]) => isPlaceholderUrl(url)).map(([field]) => field);
  if (badUrls.length > 0) {
    throw new Error(
      `Cannot submit: ${badUrls.join(', ')} still hold placeholder host(s). Run \`autohisab-business deploy\` first.`,
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
      webhook_url: sync.webhook_url,
      version: opts.version,
      scopes: manifest.scopes ?? [],
      subscribed_events: sync.subscribed_events,
      schedules: sync.schedules,
      embed_blocks: manifest.embed_blocks ?? [],
      nav_items: manifest.nav_items ?? [],
      // Platform-hosted apps: carry the hosting decision + image digest so the
      // platform knows to deploy to k3s (not treat it as a self-hosted remote).
      hosting_target: manifest.hosting_target,
      image_digest: manifest.image_digest,
    },
  );
}
