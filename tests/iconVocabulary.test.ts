import { describe, expect, it } from 'vitest';

import { DEFAULT_ICON, iconVocabulary, isKnownIcon } from '../src/services/icon-vocabulary';

describe('icon-vocabulary', () => {
  it('loads a non-empty vocabulary containing the icons doctor/push tests rely on', () => {
    const names = iconVocabulary();
    expect(names.size).toBeGreaterThan(0);
    expect(names.has('home')).toBe(true);
    expect(names.has('plus')).toBe(true);
    expect(names.has('cog-6-tooth')).toBe(true);
  });

  it('the default fallback icon is itself a known icon', () => {
    expect(isKnownIcon(DEFAULT_ICON)).toBe(true);
  });

  it('recognises a known icon and rejects an unknown one', () => {
    expect(isKnownIcon('home')).toBe(true);
    expect(isKnownIcon('panorama')).toBe(false);
  });

  it('rejects a malformed icon name (path traversal, punctuation)', () => {
    expect(isKnownIcon('../../etc/passwd')).toBe(false);
    expect(isKnownIcon('')).toBe(false);
    expect(isKnownIcon('  ')).toBe(false);
  });
});
