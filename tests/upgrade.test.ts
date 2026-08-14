import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upgradeApp, sha256, type TemplateManifest } from '../src/services/template-manifest';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-test-'));
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

describe('upgradeApp', () => {
  it('upgrades a file whose local content hashes to a known OLDER template version', async () => {
    const templateRoot = await tempDir();
    const cwd = await tempDir();

    const oldContent = '/* @flashmandu-template next.config.js@0.3.0 */\nmodule.exports = { reactStrictMode: true };\n';
    const newContent = '/* @flashmandu-template next.config.js@0.4.0 */\nexport default { reactStrictMode: true, transpilePackages: [] };\n';

    await write(templateRoot, 'next.config.js', newContent);
    await write(cwd, 'next.config.js', oldContent);

    const manifest: TemplateManifest = {
      'next.config.js': {
        '0.3.0': sha256(oldContent),
        '0.4.0': sha256(newContent),
      },
    };

    const results = upgradeApp(cwd, { templateRoot, manifest });
    const nextConfig = results.find((r) => r.rel === 'next.config.js');
    expect(nextConfig?.status).toBe('upgraded');
    expect(await fs.readFile(path.join(cwd, 'next.config.js'), 'utf8')).toBe(newContent);
  });

  it('leaves a hand-edited file alone and reports it forked', async () => {
    const templateRoot = await tempDir();
    const cwd = await tempDir();

    const newContent = '/* @flashmandu-template lib/purge.ts@0.4.0 */\nexport async function purgeProfileData() { return {}; }\n';
    const handEdited = '/* @flashmandu-template lib/purge.ts@0.4.0 */\nexport async function purgeProfileData(id: string) {\n  await db.item.deleteMany({ where: { profileId: id } });\n  return { items: 1 };\n}\n';

    await write(templateRoot, 'lib/purge.ts', newContent);
    await write(cwd, 'lib/purge.ts', handEdited);

    const manifest: TemplateManifest = {
      'lib/purge.ts': { '0.4.0': sha256(newContent) },
    };

    const results = upgradeApp(cwd, { templateRoot, manifest });
    const purge = results.find((r) => r.rel === 'lib/purge.ts');
    expect(purge?.status).toBe('forked');
    // Untouched — the developer's own purge logic survives.
    expect(await fs.readFile(path.join(cwd, 'lib/purge.ts'), 'utf8')).toBe(handEdited);
  });

  it('creates a missing kit-owned file', async () => {
    const templateRoot = await tempDir();
    const cwd = await tempDir();

    const content = '/* @flashmandu-template app/not-found.tsx@0.4.0 */\nexport default function NotFound() { return null; }\n';
    await write(templateRoot, 'app/not-found.tsx', content);
    // cwd has no app/not-found.tsx at all — simulates an app scaffolded before
    // this file existed in the template.

    const manifest: TemplateManifest = { 'app/not-found.tsx': { '0.4.0': sha256(content) } };
    const results = upgradeApp(cwd, { templateRoot, manifest });

    const notFound = results.find((r) => r.rel === 'app/not-found.tsx');
    expect(notFound?.status).toBe('created');
    expect(await fs.readFile(path.join(cwd, 'app', 'not-found.tsx'), 'utf8')).toBe(content);
  });

  it('reports a byte-identical file as unchanged, not upgraded', async () => {
    const templateRoot = await tempDir();
    const cwd = await tempDir();

    const content = '/* @flashmandu-template app/loading.tsx@0.4.0 */\nexport default function L() { return null; }\n';
    await write(templateRoot, 'app/loading.tsx', content);
    await write(cwd, 'app/loading.tsx', content);

    const manifest: TemplateManifest = { 'app/loading.tsx': { '0.4.0': sha256(content) } };
    const results = upgradeApp(cwd, { templateRoot, manifest });

    expect(results.find((r) => r.rel === 'app/loading.tsx')?.status).toBe('unchanged');
  });

  it('against the CLI-bundled template: every kit-owned file upgrades cleanly from its own current hash', async () => {
    // Sanity check against the REAL shipped template (default manifest/root),
    // simulating an app that is still exactly at TEMPLATE_VERSION — the most
    // common case `upgrade` runs against.
    const { defaultManifest, resolveTemplateRoot, KIT_OWNED_FILES } = await import('../src/services/template-manifest');
    const templateRoot = resolveTemplateRoot();
    const cwd = await tempDir();

    for (const rel of KIT_OWNED_FILES) {
      const abs = path.join(templateRoot, rel);
      const content = await fs.readFile(abs, 'utf8');
      await write(cwd, rel, content);
    }

    const results = upgradeApp(cwd, { manifest: defaultManifest() });
    expect(results.every((r) => r.status === 'unchanged')).toBe(true);
  });
});
