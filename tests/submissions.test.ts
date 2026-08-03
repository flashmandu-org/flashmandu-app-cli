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
      expect.objectContaining({ app_id: 'widget', version: '1.0.1' }),
      { noAuth: true },
    );
  });
});
