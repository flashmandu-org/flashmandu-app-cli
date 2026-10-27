import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as fs, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KIT_OWNED_FILES, upgradeApp } from '../src/services/template-manifest';
import { PINNED_KITS } from '../src/services/kit-versions';
import { tgzFilename } from '../src/services/kit';

/**
 * `upgrade` must never leave an app that does not build.
 *
 * Template 0.5.0 made `lib/storage.ts` and `lib/mcp.ts` kit-owned, so
 * `upgrade` CREATES them in an app scaffolded earlier — an app whose
 * package.json has no `@aws-sdk/*`. This fixture is exactly that app: the
 * kit-owned files and package.json as they shipped at 0.4.0 (read from git),
 * the bridge kit it would have vendored, and NO aws packages anywhere on the
 * resolution path. After `upgradeApp` it must:
 *
 *   1. typecheck (`tsc --noEmit`, strict, bundler resolution);
 *   2. bundle (esbuild resolves every static and literal-dynamic import the
 *      way Next's bundler would; an unresolvable `@aws-sdk/*` fails here);
 *   3. run the local storage driver (the default) end to end.
 */

const CLI_ROOT = path.join(__dirname, '..');
const V0_4_0_COMMIT = '4bc4b56';
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

function gitShow(rel: string): string | null {
  try {
    return execFileSync('git', ['show', `${V0_4_0_COMMIT}:src/templates/next-js/${rel}`], {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

async function scaffold040App(): Promise<string> {
  const app = mkdtempSync(path.join(os.tmpdir(), 'upgrade-builds-'));
  roots.push(app);
  for (const rel of [...KIT_OWNED_FILES, 'package.json']) {
    const content = gitShow(rel);
    if (content === null) continue;
    await fs.mkdir(path.dirname(path.join(app, rel)), { recursive: true });
    await fs.writeFile(path.join(app, rel), content);
  }
  // node_modules: only what a 0.4.0 app really has that these files touch —
  // @types/node and the vendored bridge kit. Deliberately no @aws-sdk/*.
  const nm = path.join(app, 'node_modules');
  await fs.mkdir(path.join(nm, '@types'), { recursive: true });
  await fs.mkdir(path.join(nm, '@flashmandu'), { recursive: true });
  symlinkSync(path.join(CLI_ROOT, 'node_modules', '@types', 'node'), path.join(nm, '@types', 'node'));
  const bridgeDir = path.join(nm, '@flashmandu', 'app-bridge');
  await fs.mkdir(bridgeDir, { recursive: true });
  const tgz = path.join(CLI_ROOT, 'assets', 'kits', tgzFilename('@flashmandu/app-bridge', PINNED_KITS['@flashmandu/app-bridge']!));
  execFileSync('tar', ['xzf', tgz, '-C', bridgeDir, '--strip-components=1']);
  writeFileSync(
    path.join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node'],
        baseUrl: '.',
        paths: { '@/*': ['./*'] },
      },
      files: ['lib/storage.ts', 'lib/mcp.ts'],
    }),
  );
  return app;
}

describe('upgrade of a 0.4.0 app with no @aws-sdk deps', () => {
  it('creates the new kit-owned files and the app still typechecks, bundles and stores files locally', async () => {
    const app = await scaffold040App();
    const pkg = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {}).some((d) => d.startsWith('@aws-sdk/'))).toBe(false);

    const results = upgradeApp(app);
    expect(results.find((r) => r.rel === 'lib/storage.ts')?.status).toBe('created');
    expect(results.find((r) => r.rel === 'lib/mcp.ts')?.status).toBe('created');

    // 1. typecheck
    const tsc = path.join(CLI_ROOT, 'node_modules', '.bin', 'tsc');
    let tscOut = '';
    try {
      execFileSync(tsc, ['-p', path.join(app, 'tsconfig.json')], { cwd: app, encoding: 'utf8' });
    } catch (err) {
      tscOut = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(tscOut).toBe('');

    // 2. bundle (no externals: every resolvable import must resolve)
    const { build } = await import('esbuild');
    const out = path.join(app, 'out', 'storage.cjs');
    await build({
      entryPoints: [path.join(app, 'lib', 'storage.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out,
      logLevel: 'silent',
    });

    // 3. the local driver runs with no aws package installed
    const uploads = path.join(app, 'uploads');
    const script = `
      process.env.UPLOADS_DIR = ${JSON.stringify(uploads)};
      const s = require(${JSON.stringify(out)});
      (async () => {
        const st = s.getStorage();
        await st.save('p1/a.jpg', Buffer.from('x'));
        const n = await st.removePrefix('p1/');
        process.stdout.write(st.driver + ':' + n);
      })().catch((e) => { process.stdout.write('ERR ' + e.message); });
    `;
    expect(execFileSync(process.execPath, ['-e', script], { cwd: app, encoding: 'utf8' })).toBe('local:1');
  }, 60_000);

  it('the S3 driver explains the missing packages instead of crashing the build', async () => {
    const app = await scaffold040App();
    upgradeApp(app);
    const { build } = await import('esbuild');
    const out = path.join(app, 'out', 'storage.cjs');
    await build({ entryPoints: [path.join(app, 'lib', 'storage.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const script = `
      Object.assign(process.env, { S3_ENDPOINT: 'https://r2.example.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' });
      const s = require(${JSON.stringify(out)});
      s.getStorage().save('p1/a.jpg', Buffer.from('x'))
        .then(() => process.stdout.write('saved'))
        .catch((e) => process.stdout.write(e.name + ': ' + e.message));
    `;
    const said = execFileSync(process.execPath, ['-e', script], { cwd: app, encoding: 'utf8' });
    expect(said).toMatch(/^StorageError: .*@aws-sdk\/client-s3/);
  }, 60_000);
});
