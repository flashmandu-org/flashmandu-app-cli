import { describe, expect, it } from 'vitest';
import { deriveUrls } from '../src/services/hosting';

describe('deriveUrls', () => {
  it('derives the three urls from a base', () => {
    expect(deriveUrls('https://map.acme.com')).toEqual({
      authorize_url: 'https://map.acme.com/oauth/authorize',
      token_url: 'https://map.acme.com/oauth/token',
      webhook_url: 'https://map.acme.com/webhooks/flashmandu',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(deriveUrls('https://map.acme.com/').authorize_url)
      .toBe('https://map.acme.com/oauth/authorize');
  });

  it('preserves a path prefix', () => {
    expect(deriveUrls('https://acme.com/map').token_url)
      .toBe('https://acme.com/map/oauth/token');
  });

  it('rejects a non-https base', () => {
    expect(() => deriveUrls('http://map.acme.com')).toThrow(/https/i);
  });
});
