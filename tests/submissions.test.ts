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

describe('submitAppForReview — Style Surface namespace (same flatten as dev)', () => {
  const surfaced = {
    type: 'virtual-tour', name: 'Virtual Tour', block_path: '/embed/virtual-tour',
    style_surfaces: [{ key: 'pin_card', name: 'Info card', slots: [{ key: 'radius', var: '--tours-card-radius', type: 'length' }] }],
  };
  const plain = { type: 'plain', name: 'Plain', block_path: '/embed/plain' };

  it('carries style_var_prefix + style_schema_version on every surfaced block and top-level', async () => {
    (apiClient.post as any).mockResolvedValue({ id: 21 });
    await submitAppForReview(
      { ...manifest, style_var_prefix: '--tours', style_schema_version: 2, embed_blocks: [surfaced, plain] },
      { version: '2.0.0' },
    );
    const body = (apiClient.post as any).mock.calls.at(-1)[1];
    expect(body.style_var_prefix).toBe('--tours');
    expect(body.style_schema_version).toBe(2);
    expect(body.embed_blocks[0]).toMatchObject({ type: 'virtual-tour', style_var_prefix: '--tours', style_schema_version: 2 });
    expect(body.embed_blocks[0].style_surfaces).toEqual(surfaced.style_surfaces);
    // A block with no surfaces is sent untouched (no new keys).
    expect(body.embed_blocks[1]).toEqual(plain);
  });

  it('defaults style_schema_version to 1, like dev, and sends nothing extra without surfaces', async () => {
    (apiClient.post as any).mockResolvedValue({ id: 22 });
    await submitAppForReview({ ...manifest, style_var_prefix: '--tours', embed_blocks: [surfaced] }, { version: '2.0.1' });
    let body = (apiClient.post as any).mock.calls.at(-1)[1];
    expect(body.embed_blocks[0].style_schema_version).toBe(1);
    expect(body.style_schema_version).toBe(1);

    await submitAppForReview({ ...manifest, embed_blocks: [plain] }, { version: '2.0.2' });
    body = (apiClient.post as any).mock.calls.at(-1)[1];
    expect('style_var_prefix' in body).toBe(false);
    expect('style_schema_version' in body).toBe(false);
    expect(body.embed_blocks).toEqual([plain]);
  });
});
