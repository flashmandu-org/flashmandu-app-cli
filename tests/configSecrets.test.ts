import { describe, expect, it } from 'vitest';
import {
  SECRET_KEY_RE,
  parseSecretAssignment,
  selfHostedSecretsGuidance,
} from '../src/commands/config';

describe('parseSecretAssignment', () => {
  it('splits KEY=value', () => {
    expect(parseSecretAssignment('STRIPE_KEY=sk_live_123')).toEqual({
      key: 'STRIPE_KEY',
      value: 'sk_live_123',
    });
  });

  it('only splits on the FIRST = so values may contain it', () => {
    expect(parseSecretAssignment('DSN=postgres://u:p@h/db?x=1')?.value).toBe(
      'postgres://u:p@h/db?x=1',
    );
    expect(parseSecretAssignment('B64=YWJj==')?.value).toBe('YWJj==');
  });

  it('trims whitespace around the key only', () => {
    expect(parseSecretAssignment(' KEY = value ')).toEqual({ key: 'KEY', value: ' value ' });
  });

  it('returns null when there is no assignment', () => {
    expect(parseSecretAssignment('base_url')).toBeNull();
    expect(parseSecretAssignment('=novalue')).toBeNull();
  });
});

describe('SECRET_KEY_RE', () => {
  it('accepts env-var shaped keys', () => {
    expect(SECRET_KEY_RE.test('STRIPE_KEY')).toBe(true);
    expect(SECRET_KEY_RE.test('A1')).toBe(true);
  });

  it('rejects lowercase, leading digits and dashes', () => {
    expect(SECRET_KEY_RE.test('stripe_key')).toBe(false);
    expect(SECRET_KEY_RE.test('1KEY')).toBe(false);
    expect(SECRET_KEY_RE.test('MY-KEY')).toBe(false);
  });
});

describe('selfHostedSecretsGuidance', () => {
  it('names the app’s own hosting target instead of silently accepting', () => {
    const message = selfHostedSecretsGuidance('vercel');
    expect(message).toMatch(/hosting_target is "vercel"/);
    expect(message).toMatch(/vercel env add/);
  });

  it('handles an unset hosting target', () => {
    expect(selfHostedSecretsGuidance(undefined)).toMatch(/"unset"/);
  });

  it('states that hosted secrets are platform-target only', () => {
    expect(selfHostedSecretsGuidance('self')).toMatch(/--target platform/);
  });
});
