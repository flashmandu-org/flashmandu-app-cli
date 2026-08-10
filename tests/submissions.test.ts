import { describe, expect, it, vi } from 'vitest';
import { submitAppForReview } from '../src/services/submissions';
import * as apiClient from '../src/services/apiClient';

vi.mock('../src/services/apiClient', () => ({
  post: vi.fn(),
  get: vi.fn(),
  request: vi.fn(),
}));

const manifest: any = {
  slug: 'widget', name: 'Widget', developer_name: 'Acme', developer_email: 'd@acme.com',
  authorize_url: 'https://widget.acme.com/oauth/authorize',
  token_url: 'https://widget.acme.com/oauth/token',
  webhook_url: 'https://widget.acme.com/webhooks/flashmandu',
  scopes: [], subscribed_events: [], embed_blocks: [], nav_items: [],
};

describe('submitAppForReview', () => {
  it('throws when an OAuth URL is a placeholder', async () => {
    await expect(submitAppForReview({ ...manifest, authorize_url: 'https://APP-HOST/x' }, { version: '1.0.0' }))
      .rejects.toThrow(/placeholder/);
  });

  it('posts the manifest + version to the submissions endpoint', async () => {
    (apiClient.post as any).mockResolvedValue({ id: 7, app_id: 'acme/widget' });
    const res = await submitAppForReview(manifest, { version: '1.0.1' });
    expect(res.id).toBe(7);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/apps/app-submissions',
      // Authenticated: the server resolves the publisher from the bearer, so
      // there is no third options argument.
      expect.objectContaining({ app_id: 'widget', version: '1.0.1' }),
    );
  });

  it('syncs [webhooks] events + url and [[schedules]] with the submission', async () => {
    (apiClient.post as any).mockResolvedValue({ id: 11 });
    await submitAppForReview(
      {
        ...manifest,
        subscribed_events: ['legacy.event'],
        webhooks: { url: 'https://hooks.acme.com/in', events: ['order.created'] },
        schedules: [{ name: 'rollup', every: '15m' }],
      },
      { version: '1.0.2' },
    );

    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/apps/app-submissions',
      expect.objectContaining({
        webhook_url: 'https://hooks.acme.com/in',
        subscribed_events: ['order.created'],
        schedules: [{ name: 'rollup', every: '15m', interval_seconds: 900 }],
      }),
    );
  });

  it('validates the placeholder guard against the [webhooks] url, not just webhook_url', async () => {
    await expect(
      submitAppForReview(
        { ...manifest, webhooks: { url: 'https://APP-HOST/in', events: [] } },
        { version: '1.0.3' },
      ),
    ).rejects.toThrow(/placeholder/);
  });

  it('accepts real URLs spread over a placeholder manifest (deploy --target platform shape)', async () => {
    // Regression guard for the first-deploy bug: deploy.ts derives real
    // platform URLs and must spread them over the in-memory manifest before
    // submit, otherwise the helper's placeholder check throws on a fresh
    // template whose manifest still carries APP-HOST placeholders.
    (apiClient.post as any).mockResolvedValue({ id: 9, app_id: 'acme/widget' });
    const freshTemplate: any = {
      ...manifest,
      authorize_url: 'https://APP-HOST/oauth/authorize',
      token_url: 'https://APP-HOST/oauth/token',
      webhook_url: 'https://APP-HOST/webhooks/flashmandu',
    };
    const derivedUrls = {
      authorize_url: 'https://widget.apps.flashmandu.app/oauth/authorize',
      token_url: 'https://widget.apps.flashmandu.app/oauth/token',
      webhook_url: 'https://widget.apps.flashmandu.app/webhooks/flashmandu',
    };
    const res = await submitAppForReview({ ...freshTemplate, ...derivedUrls }, { version: '0.2.0' });
    expect(res.id).toBe(9);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/apps/app-submissions',
      expect.objectContaining({ authorize_url: derivedUrls.authorize_url, version: '0.2.0' }),
    );
  });
});
