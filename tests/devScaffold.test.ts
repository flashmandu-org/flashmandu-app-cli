import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldApp } from '../src/commands/init';
import { readManifest, MANIFEST_FILENAME } from '../src/services/manifest';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dev-scaffold-'));
}

describe('scaffoldApp (non-interactive options)', () => {
  it('scaffolds a template + flashmandu.app.toml into a temp dir', async () => {
    const dir = await tempDir();
    const result = await scaffoldApp(dir, {
      template: 'next-js',
      appSlug: 'my-test-app',
      name: 'My Test App',
    });
    expect(result).toBe('done');

    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    expect(await fs.readFile(manifestPath, 'utf8')).toContain('my-test-app');

    // The written manifest round-trips through readManifest.
    const manifest = await readManifest(dir);
    expect(manifest.slug).toBe('my-test-app');
    expect(manifest.name).toBe('My Test App');

    // Template files were copied.
    expect((await fs.readdir(dir)).length).toBeGreaterThan(1);
  });

  it('rejects an unknown template without touching the directory', async () => {
    const dir = await tempDir();
    await expect(
      scaffoldApp(dir, { template: 'nope', appSlug: 'my-app', name: 'My App' }),
    ).rejects.toThrow(/Unknown template/);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe('dev missing-manifest behavior (non-TTY)', () => {
  it('readManifest still throws the helpful missing-manifest error', async () => {
    const dir = await tempDir();
    await expect(readManifest(dir)).rejects.toThrow(
      /No flashmandu\.app\.toml found in .*autohisab-business init my-app/s,
    );
  });
});
