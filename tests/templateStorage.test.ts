import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The starter's ONE storage driver (`src/templates/next-js/lib/storage.ts`).
 *
 * Tours and Orbit each carried a private copy of the same local + S3 driver;
 * this file is the extracted original every scaffolded app now ships, and the
 * copy apps vendor byte-for-byte. These tests pin its contract:
 *
 *   - key safety (the local driver's only defence against path traversal);
 *   - local driver round-trip, idempotent remove, prefix purge with a count;
 *   - S3 driver: put/delete/paginated prefix purge/presign/public URL;
 *   - driver selection from env (STORAGE_DRIVER wins, complete S3_* set
 *     selects s3, a forced s3 with an incomplete set fails loudly).
 *
 * The AWS SDK is not a CLI dependency, so both SDK modules are mocked
 * virtually; the recorded commands are what the driver would send.
 */

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let listPages: Array<{ Contents?: Array<{ Key: string }>; IsTruncated?: boolean; NextContinuationToken?: string }> = [];

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class DeleteObjectsCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class S3Client {
    constructor(public config: Record<string, unknown>) {}
    async send(cmd: Command): Promise<unknown> {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof ListObjectsV2Command) {
        return listPages.shift() ?? { Contents: [], IsTruncated: false };
      }
      return {};
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, cmd: { input: Record<string, unknown> }, opts: { expiresIn: number }) =>
    `https://signed.example/${String(cmd.input.Key)}?ct=${encodeURIComponent(String(cmd.input.ContentType))}&exp=${opts.expiresIn}`,
  ),
}));

const TEMPLATE_FILE = path.join(__dirname, '..', 'src', 'templates', 'next-js', 'lib', 'storage.ts');
const S3_KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_PUBLIC_BASE_URL', 'STORAGE_DRIVER', 'UPLOADS_DIR'];
const savedEnv: Record<string, string | undefined> = {};
const roots: string[] = [];

type StorageModule = typeof import('../src/templates/next-js/lib/storage');

async function load(): Promise<StorageModule> {
  vi.resetModules();
  return import('../src/templates/next-js/lib/storage');
}

function useS3Env(overrides: Record<string, string> = {}): void {
  process.env.S3_ENDPOINT = 'https://r2.example.com/';
  process.env.S3_BUCKET = 'bucket';
  process.env.S3_ACCESS_KEY_ID = 'id';
  process.env.S3_SECRET_ACCESS_KEY = 'secret';
  Object.assign(process.env, overrides);
}

beforeEach(() => {
  for (const k of S3_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-storage-'));
  roots.push(root);
  process.env.UPLOADS_DIR = root;
  sent.length = 0;
  listPages = [];
});

afterEach(() => {
  for (const k of S3_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(async () => {
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe('starter lib/storage.ts ships as a kit file', () => {
  it('carries the template marker header and no app-specific names', () => {
    const src = readFileSync(TEMPLATE_FILE, 'utf8');
    expect(src.startsWith('/* @flashmandu-template lib/storage.ts@')).toBe(true);
    // The extracted driver is app-agnostic: no Tours/Orbit env names leak in.
    expect(src).not.toMatch(/TOURS_|ORBIT_/);
    // Server-only: nothing may be exposed to the browser bundle.
    expect(src).not.toMatch(/NEXT_PUBLIC_/);
  });

  it('declares the AWS SDK packages it imports in the template package.json', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'src', 'templates', 'next-js', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeTruthy();
    expect(pkg.dependencies['@aws-sdk/s3-request-presigner']).toBeTruthy();
  });
});

describe('key safety', () => {
  it('accepts strict relative keys and rejects traversal and odd charsets', async () => {
    const { isSafeKey } = await load();
    expect(isSafeKey('p1/a2/original.jpg')).toBe(true);
    expect(isSafeKey('p1/')).toBe(true);
    for (const bad of ['', '../x', 'p1/../../etc', '/abs', '.hidden', 'p1/a b', 'p1/%2e%2e', 'p1\\a']) {
      expect(isSafeKey(bad), bad).toBe(false);
    }
  });

  it('resolveLocalPath confines every key to UPLOADS_DIR', async () => {
    const { resolveLocalPath, StorageError } = await load();
    const root = process.env.UPLOADS_DIR as string;
    expect(resolveLocalPath('p1/a/b.jpg')).toBe(path.join(path.resolve(root), 'p1/a/b.jpg'));
    expect(() => resolveLocalPath('../escape')).toThrow(StorageError);
  });

  it('profilePrefix and extensionOf build keys the drivers accept', async () => {
    const { profilePrefix, extensionOf, isSafeKey, StorageError } = await load();
    expect(profilePrefix(42)).toBe('p42/');
    expect(isSafeKey(profilePrefix(42))).toBe(true);
    expect(() => profilePrefix(0)).toThrow(StorageError);
    expect(() => profilePrefix(1.5)).toThrow(StorageError);
    expect(extensionOf('PANO.JPG', ['.jpg', '.png'])).toBe('.jpg');
    expect(() => extensionOf('evil.exe', ['.jpg'])).toThrow(StorageError);
    expect(() => extensionOf('noext', ['.jpg'])).toThrow(StorageError);
  });

  it('contentTypeForKey maps known extensions and defaults to octet-stream', async () => {
    const { contentTypeForKey } = await load();
    expect(contentTypeForKey('a/b.JPG')).toBe('image/jpeg');
    expect(contentTypeForKey('a/b.jpeg')).toBe('image/jpeg');
    expect(contentTypeForKey('a/b.png')).toBe('image/png');
    expect(contentTypeForKey('a/b.webp')).toBe('image/webp');
    expect(contentTypeForKey('a/b.glb')).toBe('model/gltf-binary');
    expect(contentTypeForKey('a/b.gltf')).toBe('model/gltf+json');
    // SVG is deliberately NOT served as an image: it can carry script.
    expect(contentTypeForKey('a/b.svg')).toBe('application/octet-stream');
    expect(contentTypeForKey('a/b')).toBe('application/octet-stream');
  });
});

describe('removePrefix only ever takes a slashed tenant prefix (both drivers)', () => {
  const refused = ['', 'p1', 'p1/a', 'x/', 'a1/', 'p/', 'pa/', '../', 'p1/../', '/p1/'];
  const allowed = ['p1/', 'p12/a3/', 'p12/a3/tiles/'];

  it('isTenantPrefix is the one rule', async () => {
    const { isTenantPrefix } = await load();
    for (const p of refused) expect(isTenantPrefix(p), p).toBe(false);
    for (const p of allowed) expect(isTenantPrefix(p), p).toBe(true);
  });

  it('local: a non-tenant prefix removes nothing', async () => {
    const { getStorage } = await load();
    const storage = getStorage();
    await storage.save('p1/a/x.jpg', Buffer.from('x'));
    for (const p of refused) expect(await storage.removePrefix(p), p).toBe(0);
    expect(await storage.removePrefix('p1/a/')).toBe(1);
  });

  it('s3: a non-tenant prefix never lists or deletes', async () => {
    useS3Env();
    const { getStorage } = await load();
    for (const p of refused) expect(await getStorage().removePrefix(p), p).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('local driver', () => {
  it('is the default and round-trips bytes', async () => {
    const { getStorage, resolveLocalPath } = await load();
    const storage = getStorage();
    expect(storage.driver).toBe('local');
    await storage.save('p1/a1/original.jpg', Buffer.from('hello'));
    expect(readFileSync(resolveLocalPath('p1/a1/original.jpg'), 'utf8')).toBe('hello');
    expect(storage.url('p1/a1/original.jpg')).toBe('/api/files/p1/a1/original.jpg');
  });

  it('remove is idempotent and refuses unsafe keys', async () => {
    const { getStorage, StorageError } = await load();
    const storage = getStorage();
    await storage.remove('p1/missing.jpg');
    await expect(storage.save('../x', Buffer.from('x'))).rejects.toThrow(StorageError);
    await expect(storage.remove('../x')).rejects.toThrow(StorageError);
  });

  it('removePrefix deletes a whole profile folder and counts the files', async () => {
    const { getStorage, resolveLocalPath } = await load();
    const storage = getStorage();
    await storage.save('p7/a1/original.jpg', Buffer.from('1'));
    await storage.save('p7/a1/tiles/0/f.jpg', Buffer.from('2'));
    await storage.save('p7/a2/preview.jpg', Buffer.from('3'));
    await storage.save('p8/a1/original.jpg', Buffer.from('other tenant'));
    expect(await storage.removePrefix('p7/')).toBe(3);
    expect(existsSync(resolveLocalPath('p7'))).toBe(false);
    expect(existsSync(resolveLocalPath('p8/a1/original.jpg'))).toBe(true);
    expect(await storage.removePrefix('p7/')).toBe(0);
  });

  it('removePrefix never deletes the uploads root or escapes it', async () => {
    const { getStorage } = await load();
    const storage = getStorage();
    await storage.save('p9/a.jpg', Buffer.from('x'));
    expect(await storage.removePrefix('')).toBe(0);
    expect(await storage.removePrefix('../')).toBe(0);
    expect(existsSync(path.join(process.env.UPLOADS_DIR as string, 'p9/a.jpg'))).toBe(true);
  });

  it('presignPut is refused (the app uploads through its own route)', async () => {
    const { getStorage, StorageError } = await load();
    await expect(getStorage().presignPut('p1/a.jpg', 'image/jpeg')).rejects.toThrow(StorageError);
  });

  it('STORAGE_DRIVER=local wins over a complete S3 env', async () => {
    useS3Env({ STORAGE_DRIVER: 'local' });
    const { getStorage } = await load();
    expect(getStorage().driver).toBe('local');
  });
});

describe('s3 driver', () => {
  it('is selected by a complete S3_* set and fails loudly when forced without one', async () => {
    process.env.STORAGE_DRIVER = 's3';
    let mod = await load();
    expect(() => mod.getStorage()).toThrow(mod.StorageError);
    useS3Env();
    delete process.env.STORAGE_DRIVER;
    mod = await load();
    expect(mod.getStorage().driver).toBe('s3');
  });

  it('save/remove send the right commands with a content type', async () => {
    useS3Env();
    const { getStorage, StorageError } = await load();
    const s3 = getStorage();
    await s3.save('p1/a1/original.png', Buffer.from('x'));
    await s3.remove('p1/a1/original.png');
    expect(sent.map((c) => c.name)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
    expect(sent[0]?.input).toMatchObject({ Bucket: 'bucket', Key: 'p1/a1/original.png', ContentType: 'image/png' });
    await expect(s3.save('../x', Buffer.from('x'))).rejects.toThrow(StorageError);
    await expect(s3.remove('../x')).rejects.toThrow(StorageError);
  });

  it('removePrefix walks every page and returns the deleted count', async () => {
    useS3Env();
    listPages = [
      { Contents: [{ Key: 'p5/a' }, { Key: 'p5/b' }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'p5/c' }], IsTruncated: false },
    ];
    const { getStorage } = await load();
    expect(await getStorage().removePrefix('p5/')).toBe(3);
    const lists = sent.filter((c) => c.name === 'ListObjectsV2Command');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.input).toMatchObject({ Bucket: 'bucket', Prefix: 'p5/' });
    expect(lists[1]?.input).toMatchObject({ ContinuationToken: 't1' });
    expect(sent.filter((c) => c.name === 'DeleteObjectsCommand')).toHaveLength(2);
    // An unsafe or empty prefix never lists (an empty prefix would be the whole bucket).
    sent.length = 0;
    expect(await getStorage().removePrefix('')).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('url uses S3_PUBLIC_BASE_URL, else <endpoint>/<bucket>', async () => {
    useS3Env();
    let mod = await load();
    expect(mod.getStorage().url('p1/x.jpg')).toBe('https://r2.example.com/bucket/p1/x.jpg');
    useS3Env({ S3_PUBLIC_BASE_URL: 'https://cdn.example.com/' });
    mod = await load();
    expect(mod.getStorage().url('p1/x.jpg')).toBe('https://cdn.example.com/p1/x.jpg');
  });

  it('presignPut signs a 15-minute PUT and echoes the key', async () => {
    useS3Env();
    const { getStorage, StorageError } = await load();
    const signed = await getStorage().presignPut('p1/a.jpg', 'image/jpeg');
    expect(signed.key).toBe('p1/a.jpg');
    expect(signed.url).toBe('https://signed.example/p1/a.jpg?ct=image%2Fjpeg&exp=900');
    await expect(getStorage().presignPut('../a', 'image/jpeg')).rejects.toThrow(StorageError);
  });

  it('storageInfo describes the active driver', async () => {
    let mod = await load();
    expect(mod.storageInfo()).toEqual({ driver: 'local', detail: process.env.UPLOADS_DIR });
    useS3Env({ S3_PUBLIC_BASE_URL: 'https://cdn.example.com' });
    mod = await load();
    expect(mod.storageInfo()).toEqual({
      driver: 's3',
      detail: 'https://r2.example.com/bucket (cdn: https://cdn.example.com)',
    });
  });
});

describe('local driver — storage that is not set up is a human error, never an errno or a path', () => {
  async function readOnlyRoot(): Promise<string> {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'starter-storage-ro-'));
    roots.push(parent);
    await fs.chmod(parent, 0o500);
    return path.join(parent, 'uploads');
  }

  afterEach(async () => {
    // Let afterAll clean the read-only parents.
    for (const r of roots) await fs.chmod(r, 0o700).catch(() => {});
  });

  it('assertStorageWritable passes for a writable root and creates it', async () => {
    const root = path.join(process.env.UPLOADS_DIR!, 'fresh');
    process.env.UPLOADS_DIR = root;
    const { assertStorageWritable } = await load();
    await expect(assertStorageWritable()).resolves.toBeUndefined();
    expect(existsSync(root)).toBe(true);
  });

  it('assertStorageWritable fails up front with code "unavailable" and a human message', async () => {
    process.env.UPLOADS_DIR = await readOnlyRoot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { assertStorageWritable, StorageError, STORAGE_UNAVAILABLE_MESSAGE } = await load();
    const err = await assertStorageWritable().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as InstanceType<typeof StorageError>).code).toBe('unavailable');
    expect((err as Error).message).toBe(STORAGE_UNAVAILABLE_MESSAGE);
    expect((err as Error).message).not.toMatch(/EACCES|EPERM|mkdir|\//);
    // The real cause still reaches the server log.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('save() into an unwritable root throws the same human StorageError, not the raw fs error', async () => {
    process.env.UPLOADS_DIR = await readOnlyRoot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getStorage, StorageError } = await load();
    const err = await getStorage()
      .save('p1/a1/original.jpg', Buffer.from('x'))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as InstanceType<typeof StorageError>).code).toBe('unavailable');
    expect((err as Error).message).not.toMatch(/EACCES|mkdir|\//);
    error.mockRestore();
  });

  it('assertStorageWritable is a no-op on the s3 driver', async () => {
    useS3Env();
    const { assertStorageWritable } = await load();
    await expect(assertStorageWritable()).resolves.toBeUndefined();
  });
});
