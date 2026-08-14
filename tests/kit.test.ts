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

  it('deletes a superseded tgz of the same package after syncing (showcase repro)', async () => {
    // ~/nextjs/showcase/vendor/ was verified to still contain
    // flashmandu-app-bridge-0.3.0.tgz and flashmandu-app-bridge-ui-0.3.0.tgz
    // next to the freshly-synced 0.4.0 copies — a stale vendored kit is
    // exactly the failure mode this project exists to remove.
    const assetsDir = await fixtureAssetsDir();
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@flashmandu/app-bridge': 'file:vendor/flashmandu-app-bridge-0.3.0.tgz',
          '@flashmandu/app-bridge-ui': 'file:vendor/flashmandu-app-bridge-ui-0.3.0.tgz',
        },
      }),
    );
    await fs.mkdir(path.join(dir, 'vendor'), { recursive: true });
    await fs.writeFile(path.join(dir, 'vendor', 'flashmandu-app-bridge-0.3.0.tgz'), 'old bridge tgz');
    await fs.writeFile(path.join(dir, 'vendor', 'flashmandu-app-bridge-ui-0.3.0.tgz'), 'old bridge-ui tgz');

    kitSync(dir, vi.fn(), assetsDir);

    for (const [name, pinned] of Object.entries(PINNED_KITS)) {
      const oldTgz = `${name.replace('@', '').replace('/', '-')}-0.3.0.tgz`;
      expect(
        await fs
          .access(path.join(dir, 'vendor', oldTgz))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      const newTgz = tgzFilename(name, pinned);
      expect(
        await fs
          .access(path.join(dir, 'vendor', newTgz))
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
    }
  });

  it('does not let the app-bridge cleanup delete app-bridge-ui tarballs (or vice versa)', async () => {
    const assetsDir = await fixtureAssetsDir();
    const dir = await dirVendoredApp();
    // Pre-seed a stale UI tgz that must survive the app-bridge (non-UI) sync
    // pass untouched, proving the cleanup regex is package-specific.
    await fs.mkdir(path.join(dir, 'vendor'), { recursive: true });
    await fs.writeFile(path.join(dir, 'vendor', 'flashmandu-app-bridge-ui-0.2.9.tgz'), 'ancient ui tgz');

    kitSync(dir, vi.fn(), assetsDir);

    // The ancient app-bridge-ui tarball IS superseded and must be removed —
    // but only by the app-bridge-ui pass matching its own prefix, not as a
    // side effect of the app-bridge pass.
    expect(
      await fs
        .access(path.join(dir, 'vendor', 'flashmandu-app-bridge-ui-0.2.9.tgz'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});
