import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KIT_OWNED_FILES,
  buildManifest,
  defaultManifest,
  resolveTemplateRoot,
  sha256,
  upgradeApp,
} from '../src/services/template-manifest';
import { HISTORICAL_TEMPLATE_HASHES } from '../src/services/template-manifest-history';

/** The commit whose src/templates/next-js tree matches what actually shipped
 * under TEMPLATE_VERSION '0.4.0' — the last commit before 9feb5e0 bumped to
 * '0.4.1' and edited app/PageChromeSetup.tsx. Used to recover the REAL
 * historical bytes for testing, rather than trusting the constant blindly. */
const V0_4_0_COMMIT = '4bc4b56';

function realFileAt(commitish: string, rel: string): string {
  return execFileSync('git', ['show', `${commitish}:src/templates/next-js/${rel}`], {
    encoding: 'utf8',
  });
}

/** Kit-owned files first shipped AFTER 0.4.0 (template 0.5.0: the shared
 * storage driver and the signed MCP endpoint). They have no 0.4.0 content,
 * so no 0.4.0 hash may be recorded for them. */
const ADDED_AFTER_0_4_0 = ['lib/storage.ts', 'lib/mcp.ts'];

function existedAt(commitish: string, rel: string): boolean {
  try {
    realFileAt(commitish, rel);
    return true;
  } catch {
    return false;
  }
}

/** Kit-owned files that existed at the 0.4.0 commit. */
const KIT_OWNED_AT_0_4_0 = KIT_OWNED_FILES.filter((rel) => !ADDED_AFTER_0_4_0.includes(rel));

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-history-test-'));
}

describe('HISTORICAL_TEMPLATE_HASHES', () => {
  it('the files added after 0.4.0 are kit-owned, really absent at 0.4.0, and carry no invented 0.4.0 hash', () => {
    for (const rel of ADDED_AFTER_0_4_0) {
      expect(KIT_OWNED_FILES).toContain(rel);
      expect(existedAt(V0_4_0_COMMIT, rel), `${rel} must not exist at ${V0_4_0_COMMIT}`).toBe(false);
      expect(HISTORICAL_TEMPLATE_HASHES[rel]?.['0.4.0']).toBeUndefined();
    }
    // Every OTHER kit-owned file did exist at 0.4.0 — the filter below hides nothing.
    for (const rel of KIT_OWNED_AT_0_4_0) {
      expect(existedAt(V0_4_0_COMMIT, rel), `${rel} should exist at ${V0_4_0_COMMIT}`).toBe(true);
    }
  });

  it('records a 0.4.0 hash for every kit-owned file that existed at that commit', () => {
    for (const rel of KIT_OWNED_AT_0_4_0) {
      expect(HISTORICAL_TEMPLATE_HASHES[rel]?.['0.4.0'], `missing 0.4.0 hash for ${rel}`).toBeTruthy();
    }
  });

  it('matches the REAL git history content at the 0.4.0 commit for every kit-owned file', () => {
    for (const rel of KIT_OWNED_AT_0_4_0) {
      const realContent = realFileAt(V0_4_0_COMMIT, rel);
      expect(HISTORICAL_TEMPLATE_HASHES[rel]['0.4.0']).toBe(sha256(realContent));
    }
  });

  it('app/PageChromeSetup.tsx differs between 0.4.0 and the current template — the one file this gap actually bit', () => {
    const templateRoot = resolveTemplateRoot();
    const currentManifest = buildManifest(templateRoot, 'current');
    expect(HISTORICAL_TEMPLATE_HASHES['app/PageChromeSetup.tsx']['0.4.0']).not.toBe(
      currentManifest['app/PageChromeSetup.tsx']['current'],
    );
  });

  it('every other kit-owned file is byte-identical between 0.4.0 and current, so its historical hash equals its current hash', () => {
    const templateRoot = resolveTemplateRoot();
    const currentManifest = buildManifest(templateRoot, 'current');
    for (const rel of KIT_OWNED_AT_0_4_0) {
      if (rel === 'app/PageChromeSetup.tsx') continue;
      expect(HISTORICAL_TEMPLATE_HASHES[rel]['0.4.0']).toBe(currentManifest[rel]['current']);
    }
  });
});

describe('upgradeApp against real recovered 0.4.0 content', () => {
  it('reports app/PageChromeSetup.tsx as upgraded (not forked) when the local copy holds genuine 0.4.0 content, and rewrites it to current', async () => {
    const cwd = await tempDir();
    const templateRoot = resolveTemplateRoot();

    // Seed every kit-owned file with its CURRENT content, except
    // PageChromeSetup.tsx, which gets the real 0.4.0 bytes recovered from
    // git — simulating an app scaffolded before the 0.4.1 template change.
    for (const rel of KIT_OWNED_FILES) {
      const abs = path.join(cwd, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (rel === 'app/PageChromeSetup.tsx') {
        await fs.writeFile(abs, realFileAt(V0_4_0_COMMIT, rel), 'utf8');
      } else {
        await fs.copyFile(path.join(templateRoot, rel), abs);
      }
    }

    const results = upgradeApp(cwd, { manifest: defaultManifest() });

    const pageChrome = results.find((r) => r.rel === 'app/PageChromeSetup.tsx');
    expect(pageChrome?.status).toBe('upgraded');
    const rewritten = await fs.readFile(path.join(cwd, 'app/PageChromeSetup.tsx'), 'utf8');
    expect(rewritten).toBe(await fs.readFile(path.join(templateRoot, 'app/PageChromeSetup.tsx'), 'utf8'));

    // Every untouched file (already at current content) reports unchanged.
    for (const r of results) {
      if (r.rel !== 'app/PageChromeSetup.tsx') {
        expect(r.status, `${r.rel} should be unchanged`).toBe('unchanged');
      }
    }
  });

  it('still leaves a hand-edited app/PageChromeSetup.tsx alone and reports it forked, even with historical hashes loaded', async () => {
    const cwd = await tempDir();
    const templateRoot = resolveTemplateRoot();

    const handEdited = `${realFileAt(V0_4_0_COMMIT, 'app/PageChromeSetup.tsx')}\n// developer note: do not touch\n`;
    await fs.mkdir(path.join(cwd, 'app'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'app/PageChromeSetup.tsx'), handEdited, 'utf8');

    const results = upgradeApp(cwd, { templateRoot, manifest: defaultManifest() });
    const pageChrome = results.find((r) => r.rel === 'app/PageChromeSetup.tsx');
    expect(pageChrome?.status).toBe('forked');
    expect(await fs.readFile(path.join(cwd, 'app/PageChromeSetup.tsx'), 'utf8')).toBe(handEdited);
  });
});
