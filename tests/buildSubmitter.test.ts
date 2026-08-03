import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSourceTarball } from '../src/services/buildSubmitter';

describe('createSourceTarball', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-build-'));
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:20\n');
    await fs.writeFile(path.join(dir, 'keep-me.txt'), 'kept');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'secret.js'), 'x');
    await fs.writeFile(path.join(dir, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(dir, '.dockerignore'), 'node_modules\n.env\n*.log\n');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('excludes files matched by .dockerignore and the safety-net heavy dirs', async () => {
    const tarball = await createSourceTarball(dir);
    const out = path.join(dir, '_extracted');
    await fs.mkdir(out);
    execFileSync('tar', ['xzf', tarball, '-C', out]);

    const entries = await collect(out);
    expect(entries.some((p) => p.endsWith('Dockerfile'))).toBe(true);
    expect(entries.some((p) => p.endsWith('keep-me.txt'))).toBe(true);
    // .dockerignore + safety net excluded these.
    expect(entries.some((p) => p.includes('node_modules'))).toBe(false);
    expect(entries.some((p) => p.endsWith('.env'))).toBe(false);
    await fs.unlink(tarball);
  });
});

async function collect(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}
