import { describe, expect, it } from 'vitest';
import { formatPlatformLogs } from '../src/services/platformLogs';

describe('formatPlatformLogs', () => {
  it('returns the raw logs when the app is running', () => {
    expect(
      formatPlatformLogs({ logs: 'server started\nrequest handled', running: true }),
    ).toBe('server started\nrequest handled');
  });

  it('notes when a running app has produced no lines yet', () => {
    expect(formatPlatformLogs({ logs: '', running: true })).toBe(
      '(app is running; no log lines yet)',
    );
  });

  it('flags a scaled-to-zero app explicitly, never an empty "no errors" response', () => {
    const out = formatPlatformLogs({ logs: '', running: false });
    expect(out).toMatch(/not running/i);
    expect(out).toMatch(/scaled to zero/i);
  });

  it('appends the last available window for a cold app when there is one', () => {
    const out = formatPlatformLogs({ logs: 'last crash line', running: false });
    expect(out).toMatch(/not running/i);
    expect(out).toContain('last crash line');
  });
});
