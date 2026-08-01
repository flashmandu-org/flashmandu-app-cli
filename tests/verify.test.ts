import { describe, expect, it } from 'vitest';
import { isPlaceholderUrl } from '../src/services/verify';

describe('isPlaceholderUrl', () => {
  it('flags the starter template placeholder', () => {
    expect(isPlaceholderUrl('https://APP-HOST/oauth/authorize')).toBe(true);
  });

  it('flags .example hosts', () => {
    expect(isPlaceholderUrl('https://dev.flashmandu.example/oauth/token')).toBe(true);
  });

  it('flags localhost', () => {
    expect(isPlaceholderUrl('http://localhost:3000/oauth/authorize')).toBe(true);
  });

  it('accepts a real https host', () => {
    expect(isPlaceholderUrl('https://widget.acme.com/oauth/authorize')).toBe(false);
  });

  it('flags an empty or unparseable url', () => {
    expect(isPlaceholderUrl('')).toBe(true);
    expect(isPlaceholderUrl('not a url')).toBe(true);
  });
});
