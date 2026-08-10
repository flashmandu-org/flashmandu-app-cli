import { describe, expect, it } from 'vitest';
import {
  applyPushLine,
  createPushState,
  formatBytes,
  parseBuildLine,
  parseSize,
  pushSummary,
  tail,
} from '../src/services/dockerProgress';

describe('formatBytes', () => {
  it('formats bytes below 1KB as whole B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('formats KB/MB/GB with 1 decimal at the right boundaries', () => {
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(12_300)).toBe('12.3 KB');
    expect(formatBytes(999_999)).toBe('1000.0 KB');
    expect(formatBytes(1_000_000)).toBe('1.0 MB');
    expect(formatBytes(182_400_000)).toBe('182.4 MB');
    expect(formatBytes(1_070_000_000)).toBe('1.1 GB');
  });

  it('handles garbage input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

describe('parseSize', () => {
  it('parses docker size strings with decimal units', () => {
    expect(parseSize('512B')).toBe(512);
    expect(parseSize('12.3MB')).toBe(12_300_000);
    expect(parseSize('1.2kB')).toBe(1200);
    expect(parseSize('1.07GB')).toBe(1_070_000_000);
    expect(parseSize('50.1MB')).toBe(50_100_000);
  });

  it('returns 0 for unparsable strings', () => {
    expect(parseSize('')).toBe(0);
    expect(parseSize('Pushing')).toBe(0);
  });
});

describe('parseBuildLine', () => {
  it('extracts the step from BuildKit plain lines', () => {
    expect(parseBuildLine('#12 3.245 [4/7] RUN npm ci')).toBe('[4/7] RUN npm ci');
    expect(parseBuildLine('#12 [4/7] RUN npm ci')).toBe('[4/7] RUN npm ci');
    expect(parseBuildLine('#25 exporting to image')).toBe('exporting to image');
    expect(parseBuildLine('#7 0.412 [2/7] COPY package.json .')).toBe('[2/7] COPY package.json .');
  });

  it('drops noise lines', () => {
    expect(parseBuildLine('#12 DONE 3.2s')).toBeUndefined();
    expect(parseBuildLine('#12 CACHED')).toBeUndefined();
    expect(parseBuildLine('#12 3.245 DONE')).toBeUndefined();
    expect(parseBuildLine('random output')).toBeUndefined();
    expect(parseBuildLine('')).toBeUndefined();
  });
});

describe('push progress aggregation', () => {
  it('aggregates per-layer progress into totals and percent', () => {
    const state = createPushState();
    const lines = [
      'The push refers to repository [registry.example.com/acme/app]',
      'a1b2c3d4: Preparing',
      'e5f6a7b8: Preparing',
      'a1b2c3d4: Layer already exists',
      'e5f6a7b8: Pushing [>                                                  ]  512B/2.1MB',
      'e5f6a7b8: Pushing [=========================>                         ]  1.1MB/2.1MB',
    ];
    for (const l of lines) applyPushLine(state, l);
    expect(pushSummary(state)).toEqual({ current: 1_100_000, total: 2_100_000, percent: 52 });

    applyPushLine(state, 'e5f6a7b8: Pushing [==================================================>]  2.1MB');
    applyPushLine(state, 'e5f6a7b8: Pushed');
    expect(pushSummary(state)).toEqual({ current: 2_100_000, total: 2_100_000, percent: 100 });
  });

  it('handles multiple concurrent layers', () => {
    const state = createPushState();
    applyPushLine(state, 'aaaaaa: Pushing [==>  ]  10MB/50MB');
    applyPushLine(state, 'bbbbbb: Pushing [==>  ]  30MB/50MB');
    applyPushLine(state, 'cccccc: Mounted from other/app');
    const s = pushSummary(state);
    expect(s.current).toBe(40_000_000);
    expect(s.total).toBe(100_000_000);
    expect(s.percent).toBe(40);
  });

  it('ignores non-progress lines', () => {
    const state = createPushState();
    expect(applyPushLine(state, 'The push refers to repository [x]')).toBe(false);
    expect(applyPushLine(state, 'a1b2c3: Preparing')).toBe(false);
    expect(applyPushLine(state, 'a1b2c3: Waiting')).toBe(false);
    expect(applyPushLine(state, 'v1: digest: sha256:abc size: 1234')).toBe(false);
    expect(pushSummary(state)).toEqual({ current: 0, total: 0, percent: 0 });
  });
});

describe('tail', () => {
  it('keeps the last n non-empty lines', () => {
    const out = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const t = tail(out, 30).split('\n');
    expect(t).toHaveLength(30);
    expect(t[0]).toBe('line 10');
    expect(t[29]).toBe('line 39');
  });
});
