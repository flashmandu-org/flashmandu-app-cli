import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULES,
  MIN_INTERVAL_SECONDS,
  describeSchedule,
  parseEvery,
  toWireSchedules,
  validateCron,
  validateSchedules,
} from '../src/services/schedules';

describe('parseEvery', () => {
  it('parses each supported unit into seconds', () => {
    expect(parseEvery('30s')).toBe(30);
    expect(parseEvery('15m')).toBe(900);
    expect(parseEvery('2h')).toBe(7200);
    expect(parseEvery('1d')).toBe(86400);
  });

  it('tolerates whitespace and casing', () => {
    expect(parseEvery(' 15 M ')).toBe(900);
  });

  it('rejects a non-duration', () => {
    expect(() => parseEvery('soon')).toThrow(/not a duration/i);
  });

  it('rejects zero', () => {
    expect(() => parseEvery('0m')).toThrow(/greater than zero/i);
  });
});

describe('validateCron', () => {
  it('accepts a five-field expression', () => {
    expect(validateCron('0 18 * * *')).toBeNull();
  });

  it('accepts steps, ranges and lists', () => {
    expect(validateCron('*/15 9-17 1,15 * 1-5')).toBeNull();
  });

  it('rejects the wrong field count', () => {
    expect(validateCron('0 18 * *')).toMatch(/exactly 5 fields/);
  });

  it('rejects unsupported field syntax', () => {
    expect(validateCron('0 18 * * MON')).toMatch(/unsupported field/);
  });
});

describe('validateSchedules', () => {
  it('accepts a valid set', () => {
    expect(
      validateSchedules([
        { name: 'rollup', every: '15m' },
        { name: 'nightly', cron: '0 18 * * *' },
      ]),
    ).toEqual([]);
  });

  it('enforces the 5-minute minimum interval', () => {
    const errors = validateSchedules([{ name: 'too-fast', every: '1m' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`${MIN_INTERVAL_SECONDS / 60} minutes`));
  });

  it('allows exactly the minimum interval', () => {
    expect(validateSchedules([{ name: 'edge', every: '5m' }])).toEqual([]);
  });

  it('caps the number of schedules per app', () => {
    const many = Array.from({ length: MAX_SCHEDULES + 1 }, (_, i) => ({
      name: `job-${i}`,
      every: '10m',
    }));
    expect(validateSchedules(many).some((e) => /at most 5/.test(e))).toBe(true);
  });

  it('rejects duplicate names', () => {
    const errors = validateSchedules([
      { name: 'rollup', every: '10m' },
      { name: 'rollup', every: '20m' },
    ]);
    expect(errors.some((e) => /Duplicate schedule name "rollup"/.test(e))).toBe(true);
  });

  it('rejects a schedule with neither every nor cron', () => {
    expect(validateSchedules([{ name: 'orphan' }])[0]).toMatch(/must declare either `every/);
  });

  it('rejects a schedule with both every and cron', () => {
    expect(validateSchedules([{ name: 'both', every: '10m', cron: '0 * * * *' }])[0]).toMatch(
      /mutually exclusive/,
    );
  });

  it('rejects an unnamed schedule', () => {
    expect(validateSchedules([{ name: '', every: '10m' }])[0]).toMatch(/missing `name`/);
  });

  it('reports every problem at once rather than the first', () => {
    expect(validateSchedules([{ name: 'BAD NAME', every: '1m' }])).toHaveLength(2);
  });
});

describe('toWireSchedules', () => {
  it('resolves every into interval_seconds', () => {
    expect(toWireSchedules([{ name: 'rollup', every: '15m' }])).toEqual([
      { name: 'rollup', every: '15m', interval_seconds: 900 },
    ]);
  });

  it('passes cron through untouched', () => {
    expect(toWireSchedules([{ name: 'nightly', cron: ' 0 18 * * * ' }])).toEqual([
      { name: 'nightly', cron: '0 18 * * *' },
    ]);
  });
});

describe('describeSchedule', () => {
  it('describes an interval schedule', () => {
    expect(describeSchedule({ name: 'rollup', every: '15m' })).toBe('rollup — every 15m');
  });

  it('describes a cron schedule with its timezone rule', () => {
    expect(describeSchedule({ name: 'nightly', cron: '0 18 * * *' })).toMatch(
      /cron 0 18 \* \* \* \(profile timezone\)/,
    );
  });
});
