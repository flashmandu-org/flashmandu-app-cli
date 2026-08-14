import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scaffoldApp } from '../src/commands/init';
import { runDoctor } from '../src/commands/doctor';
import { kitSync, tgzFilename } from '../src/services/kit';
import { PINNED_KITS } from '../src/services/kit-versions';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'init-doctor-'));
}

/** Dummy tgz fixtures — doctor/kit-status only reads the filename/version, not the archive. */
async function fixtureAssetsDir(): Promise<string> {
  const dir = await tempDir();
  for (const [name, pinned] of Object.entries(PINNED_KITS)) {
    await fs.writeFile(path.join(dir, tgzFilename(name, pinned)), 'dummy tgz fixture — not a real archive');
  }
  return dir;
}

describe('a freshly-scaffolded + kit-synced next-js app passes its own doctor', () => {
  it('every rule passes (app-css-budget may only warn)', async () => {
    const dir = await tempDir();
    const result = await scaffoldApp(dir, {
      template: 'next-js',
      appSlug: 'doctor-check-app',
      name: 'Doctor Check App',
    });
    expect(result).toBe('done');

    const assetsDir = await fixtureAssetsDir();
    // Stub the npm install step — doctor's rules only read package.json/vendor
    // file layout, never node_modules, so a real install buys the assertion
    // nothing and would make this test network-dependent and slow.
    kitSync(dir, vi.fn(), assetsDir);

    const findings = runDoctor(dir);
    const errors = findings.filter((f) => !f.ok && f.severity === 'error');

    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);

    // Every warning must be the known, accepted one: app-css-budget can warn
    // (it never fails), and nothing else may warn.
    const warnings = findings.filter((f) => !f.ok && f.severity === 'warn');
    expect(warnings.every((w) => w.rule === 'app-css-budget')).toBe(true);
  });
});
