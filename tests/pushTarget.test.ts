import { describe, expect, it } from 'vitest';
import { pushTargetNotSupported } from '../src/commands/push';

describe('pushTargetNotSupported', () => {
  it('states that hosting is chosen by deploy, not push', () => {
    expect(pushTargetNotSupported('platform')).toMatch(/deploy/);
  });

  it('explains hosting is recorded in the manifest', () => {
    expect(pushTargetNotSupported('platform')).toMatch(/manifest/i);
  });

  it('does not surface commander\'s "unknown option" wording', () => {
    expect(pushTargetNotSupported('platform')).not.toMatch(/unknown option/i);
  });
});
