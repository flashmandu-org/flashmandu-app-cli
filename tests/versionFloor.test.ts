import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseVersion,
  readBridgeVersions,
  versionFloorWarnings,
} from '../src/services/versionFloor';

describe('parseVersion', () => {
  it('parses plain and ranged versions', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('^0.3.0')).toEqual([0, 3, 0]);
    expect(parseVersion('~1.4')).toEqual([1, 4, 0]);
  });

  it('returns null for non-registry specifiers', () => {
    expect(parseVersion('workspace:*')).toBeNull();
    expect(parseVersion('file:../app-bridge')).toBeNull();
    expect(parseVersion('github:flashmandu-org/app-bridge')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns null when either side is uncomparable', () => {
    expect(compareVersions('workspace:*', '0.3.0')).toBeNull();
  });
});

describe('versionFloorWarnings', () => {
  it('warns for a package below the floor', () => {
    const warnings = versionFloorWarnings(
      { 'app-bridge': '0.2.0' },
      { 'app-bridge': '0.3.0' },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/@flashmandu\/app-bridge 0\.2\.0 is behind/);
  });

  it('stays silent when the version meets or exceeds the floor', () => {
    expect(versionFloorWarnings({ 'app-bridge': '0.3.0' }, { 'app-bridge': '0.3.0' })).toEqual([]);
    expect(versionFloorWarnings({ 'app-bridge': '1.0.0' }, { 'app-bridge': '0.3.0' })).toEqual([]);
  });

  it('stays silent when the platform advertises no floor', () => {
    expect(versionFloorWarnings({ 'app-bridge': '0.1.0' }, {})).toEqual([]);
  });

  it('stays silent when the app does not use the package', () => {
    expect(versionFloorWarnings({}, { 'app-bridge': '0.3.0' })).toEqual([]);
  });

  it('warns per package independently', () => {
    expect(
      versionFloorWarnings(
        { 'app-bridge': '0.2.0', 'app-bridge-ui': '0.2.0' },
        { 'app-bridge': '0.3.0', 'app-bridge-ui': '0.3.0' },
      ),
    ).toHaveLength(2);
  });
});

describe('readBridgeVersions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-floor-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns nothing for a directory without a package.json', async () => {
    expect(await readBridgeVersions(dir)).toEqual({});
  });

  it('reads the declared dependency range', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@flashmandu/app-bridge': '^0.2.0' } }),
      'utf8',
    );

    expect(await readBridgeVersions(dir)).toEqual({ 'app-bridge': '^0.2.0' });
  });

  it('prefers the installed version over the declared range', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@flashmandu/app-bridge': '^0.2.0' } }),
      'utf8',
    );
    const installed = path.join(dir, 'node_modules', '@flashmandu', 'app-bridge');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(
      path.join(installed, 'package.json'),
      JSON.stringify({ version: '0.4.1' }),
      'utf8',
    );

    expect(await readBridgeVersions(dir)).toEqual({ 'app-bridge': '0.4.1' });
  });
});
