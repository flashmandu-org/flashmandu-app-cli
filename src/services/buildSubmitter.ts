import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, request } from './apiClient';

/**
 * Server-side build: the CLI ships source to the platform, which builds the
 * image as a kaniko Job and returns a digest — so the developer's machine
 * never needs Docker. Used by `deploy --target platform`.
 *
 * The tarball honours `.dockerignore` (and always excludes node_modules/.git)
 * so the build context matches what a local `docker build` would send.
 */

export interface BuildResult {
  buildId: number;
  digest: string;
}

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

interface BuildStatusResponse {
  build_id: number;
  status: 'queued' | 'building' | 'succeeded' | 'failed';
  image_digest?: string | null;
  error?: string | null;
}

/** Tar the app dir (honouring .dockerignore) to a temp file, return its path. */
export async function createSourceTarball(appDir: string): Promise<string> {
  const ignores = await readDockerIgnore(appDir);
  // Safety net: these are heavy/sensitive regardless of .dockerignore.
  const always = ['node_modules', '.git', '.next', '.env', '.env.local'];
  const excludes = Array.from(new Set([...ignores, ...always]))
    .map((p) => `--exclude=./${p.replace(/^\/+/, '')}`);

  const tmp = path.join(os.tmpdir(), `flashmandu-build-${Date.now()}.tar.gz`);
  execFileSync('tar', ['czf', tmp, ...excludes, '-C', appDir, '.'], { stdio: 'pipe' });
  return tmp;
}

async function readDockerIgnore(appDir: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(appDir, '.dockerignore'), 'utf8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** Upload the source and return the new build id. */
export async function submitBuild(slug: string, tarballPath: string): Promise<number> {
  const { build_id } = await request<{ build_id: number }>('/api/apps/dev/build', {
    method: 'POST',
    body: toFormData(slug, tarballPath),
  });
  return build_id;
}

// Node 20 has a global FormData/Blob. Build the multipart body manually so the
// file streams without reading the whole tarball into memory twice.
function toFormData(slug: string, tarballPath: string): FormData {
  const form = new FormData();
  form.set('slug', slug);
  // Blob accepts a stream-backed source via the file path on disk through
  // createReadStream; here a Buffer is simplest and tarballs are capped small.
  const buf = readFileSync(tarballPath);
  form.set('source', new Blob([new Uint8Array(buf)], { type: 'application/gzip' }), 'source.tar.gz');
  return form;
}

/** Poll the build until it finishes; return the digest or throw on failure. */
export async function awaitBuild(buildId: number): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await get<BuildStatusResponse>(`/api/apps/dev/builds/${buildId}`);
    if (status.status === 'succeeded') {
      if (!status.image_digest) {
        throw new Error(`Build ${buildId} succeeded but returned no digest.`);
      }
      return status.image_digest;
    }
    if (status.status === 'failed') {
      throw new Error(`Build ${buildId} failed: ${status.error ?? 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Build ${buildId} timed out after ${POLL_TIMEOUT_MS / 1000}s.`);
}

/** Full flow: tar → upload → wait → digest. Cleans up the temp tarball. */
export async function buildOnPlatform(appDir: string, slug: string): Promise<BuildResult> {
  const tarball = await createSourceTarball(appDir);
  try {
    const buildId = await submitBuild(slug, tarball);
    const digest = await awaitBuild(buildId);
    return { buildId, digest };
  } finally {
    await fs.unlink(tarball).catch(() => {});
  }
}
