import { describe, expect, it, vi } from 'vitest';
import { installCommandFor, detectPlatform } from '../src/services/dockerRuntime';

describe('installCommandFor', () => {
  it('installs OrbStack on macOS via brew cask', () => {
    const c = installCommandFor('darwin');
    expect(c).not.toBeNull();
    expect(c!.cmd).toBe('brew');
    expect(c!.args).toEqual(['install', '--cask', 'orbstack']);
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
