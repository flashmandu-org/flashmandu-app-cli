import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { kitStatus, kitSync, tgzFilename, type Runner } from '../src/services/kit';
import { PINNED_KITS } from '../src/services/kit-versions';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kit-test-'));
}

/** Build a fixture app dir with the legacy dir-vendored `app-bridge` at 0.3.0. */
async function dirVendoredApp(): Promise<string> {
  const dir = await tempDir();
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        dependencies: {
          '@flashmandu/app-bridge': 'file:vendor/app-bridge',
          '@flashmandu/app-bridge-ui': 'file:vendor/app-bridge-ui',
        },
      },
      null,
      2,
    ),
  );
  await fs.mkdir(path.join(dir, 'vendor', 'app-bridge'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'vendor', 'app-bridge', 'package.json'),
    JSON.stringify({ name: '@flashmandu/app-bridge', version: '0.3.0' }, null, 2),
  );
  await fs.mkdir(path.join(dir, 'vendor', 'app-bridge-ui'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'vendor', 'app-bridge-ui', 'package.json'),
    JSON.stringify({ name: '@flashmandu/app-bridge-ui', version: '0.3.0' }, null, 2),
  );
  return dir;
}

/** Dummy tgz fixtures in an isolated temp dir — sync must not depend on the real (later-produced) tarballs. */
async function fixtureAssetsDir(): Promise<string> {
  const dir = await tempDir();
  for (const [name, pinned] of Object.entries(PINNED_KITS)) {
    await fs.writeFile(path.join(dir, tgzFilename(name, pinned)), 'dummy tgz fixture — not a real archive');
  }
  return dir;
}

describe('kitStatus', () => {
  it('reports dir-style vendoring with the stale installed version', async () => {
    const dir = await dirVendoredApp();
    const rows = kitStatus(dir);

    const bridge = rows.find((r) => r.name === '@flashmandu/app-bridge');
    expect(bridge).toMatchObject({
      style: 'dir',
      installed: '0.3.0',
      pinned: PINNED_KITS['@flashmandu/app-bridge'],
    });
  });

  it('reports missing when the dep is absent', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const rows = kitStatus(dir);
    expect(rows.every((r) => r.style === 'missing' && r.installed === 'none')).toBe(true);
  });

  it('reports tgz style when already vendored as a pinned tarball', async () => {
    const dir = await tempDir();
    const pinned = PINNED_KITS['@flashmandu/app-bridge'];
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@flashmandu/app-bridge': `file:vendor/${tgzFilename('@flashmandu/app-bridge', pinned)}`,
        },
      }),
    );
    const rows = kitStatus(dir);
    const bridge = rows.find((r) => r.name === '@flashmandu/app-bridge');
    expect(bridge).toMatchObject({ style: 'tgz', installed: pinned, pinned });
  });
});

describe('kitSync', () => {
  it('copies pinned tgz files, rewrites deps, deletes legacy dirs, and runs npm install', async () => {
    const assetsDir = await fixtureAssetsDir();
    const dir = await dirVendoredApp();
    const run: Runner = vi.fn();

    kitSync(dir, run, assetsDir);

    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    for (const [name, pinned] of Object.entries(PINNED_KITS)) {
      const tgz = tgzFilename(name, pinned);
      expect(pkg.dependencies[name]).toBe(`file:vendor/${tgz}`);
      expect(
        await fs
          .access(path.join(dir, 'vendor', tgz))
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
    }

    // Legacy directory-style vendoring is gone.
    expect(
      await fs
        .access(path.join(dir, 'vendor', 'app-bridge'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(
      await fs
        .access(path.join(dir, 'vendor', 'app-bridge-ui'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('npm', ['install'], dir);
  });
});
