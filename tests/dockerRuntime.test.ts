import { describe, expect, it } from 'vitest';
import { installCommandFor, detectPlatform } from '../src/services/dockerRuntime';

describe('installCommandFor', () => {
  it('installs colima + docker CLI on macOS via brew (free, no license)', () => {
    const c = installCommandFor('darwin');
    expect(c).not.toBeNull();
    expect(c!.cmd).toBe('brew');
    expect(c!.args).toEqual(['install', 'colima', 'docker']);
  });

  it('returns a docker install on linux', () => {
    const c = installCommandFor('linux');
    expect(c).not.toBeNull();
    expect(c!.args.some((a) => a.includes('docker'))).toBe(true);
  });

  it('returns a null only for truly unknown platforms', () => {
    // win32 is supported (winget guidance); unknown returns null.
    expect(installCommandFor('win32')).not.toBeNull();
    expect(installCommandFor('aix' as never)).toBeNull();
  });
});

describe('detectPlatform', () => {
  it('reads process.platform', () => {
    expect(['darwin', 'linux', 'win32']).toContain(detectPlatform());
  });
});
