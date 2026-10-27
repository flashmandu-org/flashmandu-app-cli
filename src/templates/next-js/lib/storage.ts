/* @flashmandu-template lib/storage.ts@0.5.0 */
/**
 * App file storage — one interface, two drivers, picked per call from env.
 *
 *   local (default) — files under `data/uploads/` (override with UPLOADS_DIR;
 *     tests point it at a tmp dir). Served by YOUR app's own file route at
 *     `/api/files/<key>`, which must re-check the owning row is allowed to be
 *     public before streaming (use `localPathForKey` + `createReadStream`).
 *   s3 — active when S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID /
 *     S3_SECRET_ACCESS_KEY are all set (S3-compatible: R2, MinIO, AWS). The
 *     browser uploads straight to a presigned PUT URL; reads come from the
 *     public base (S3_PUBLIC_BASE_URL, falling back to `<endpoint>/<bucket>`).
 *   STORAGE_DRIVER=local|s3 forces a driver; a forced s3 with an incomplete
 *     S3_* set throws instead of silently writing to local disk.
 *
 * KEYS. Build every key under `profilePrefix(profileId)` (`p<id>/...`) so a
 * profile's files are ONE prefix: the uninstall / GDPR purge is then a single
 * `removePrefix(profilePrefix(id))`. Keys are strict relative paths
 * (`isSafeKey`); that charset rule is the local driver's traversal defence.
 *
 * Server-only. No browser-exposed env var: every value is resolved server-side.
 * Vendored byte-for-byte by apps built before the starter shipped it (Tours);
 * change it HERE and re-vendor, never fork a copy.
 */

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Presigned PUT lifetime, seconds. */
export const PRESIGN_TTL_SECONDS = 15 * 60;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface PresignedUpload {
  /** Where the browser PUTs the file bytes. */
  url: string;
  /** The storage key the object will land under (echoed back to the client). */
  key: string;
}

export interface AppStorage {
  readonly driver: 'local' | 's3';
  /** Persist `data` under `key`, creating parent directories as needed. */
  save(key: string, data: Buffer): Promise<void>;
  /** Remove `key`. A missing object is NOT an error (purge idempotency). */
  remove(key: string): Promise<void>;
  /**
   * Remove every object under `prefix` and return how many were removed. An
   * empty or unsafe prefix removes nothing (it would mean the whole bucket).
   */
  removePrefix(prefix: string): Promise<number>;
  /** The URL the storefront / admin preview reads the file from. */
  url(key: string): string;
  /** Presign a browser-direct PUT. The local driver refuses (upload through your own route). */
  presignPut(key: string, contentType: string): Promise<PresignedUpload>;
}

// ---------------------------------------------------------------------------
// Keys (shared, and deliberately strict)
// ---------------------------------------------------------------------------

/**
 * True when `key` is a safe, relative, dot-free storage key. The charset
 * whitelist makes URL-encoding edge cases impossible, and the `..` ban keeps
 * the local driver immune to path traversal.
 */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key) && !key.includes('..');
}

/** The one prefix every key of a profile lives under: `p<profileId>/`. */
export function profilePrefix(profileId: number): string {
  if (!Number.isInteger(profileId) || profileId <= 0) {
    throw new StorageError('Invalid profile id.');
  }
  return `p${profileId}/`;
}

/**
 * The lower-cased extension of `fileName` when it is in `allowed`; throws a
 * StorageError otherwise, so a bad extension can never reach a driver.
 */
export function extensionOf(fileName: string, allowed: readonly string[]): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '' || !allowed.includes(ext)) {
    throw new StorageError(`Unsupported file type "${ext || fileName}". Allowed: ${allowed.join(', ')}.`);
  }
  return ext;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/**
 * Content-Type for a stored file (file routes + S3 put). Unknown extensions,
 * and SVG on purpose (it can carry script), are served as octet-stream.
 */
export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

function uploadsRoot(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'data', 'uploads');
}

/**
 * Resolve `key` to an absolute path INSIDE the uploads root. Belt and braces:
 * isSafeKey rejects traversal strings outright, and the resolved-prefix check
 * catches anything the regex missed.
 */
export function resolveLocalPath(key: string): string {
  if (!isSafeKey(key)) {
    throw new StorageError('Invalid storage key.');
  }
  const root = path.resolve(uploadsRoot());
  const abs = path.resolve(root, key);
  if (abs === root || !abs.startsWith(root + path.sep)) {
    throw new StorageError('Invalid storage key.');
  }
  return abs;
}

async function countFiles(abs: string): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) {
    return 1;
  }
  let n = 0;
  for (const entry of await fs.readdir(abs)) {
    n += await countFiles(path.join(abs, entry));
  }
  return n;
}

const localStorage: AppStorage = {
  driver: 'local',

  async save(key, data) {
    const abs = resolveLocalPath(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  },

  async remove(key) {
    await fs.rm(resolveLocalPath(key), { force: true });
  },

  async removePrefix(prefix) {
    let abs: string;
    try {
      abs = resolveLocalPath(prefix.replace(/\/+$/, ''));
    } catch {
      return 0;
    }
    const count = await countFiles(abs);
    await fs.rm(abs, { recursive: true, force: true });
    return count;
  },

  url(key) {
    return `/api/files/${key}`;
  },

  async presignPut() {
    throw new StorageError('The local driver does not presign; upload through the app\'s own upload route.');
  },
};

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

interface S3Env {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  publicBaseUrl: string;
}

function s3Env(): S3Env | null {
  const endpoint = process.env.S3_ENDPOINT ?? '';
  const bucket = process.env.S3_BUCKET ?? '';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
  if (endpoint === '' || bucket === '' || accessKeyId === '' || secretAccessKey === '') {
    return null;
  }
  const trimmed = endpoint.replace(/\/+$/, '');
  return {
    endpoint: trimmed,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION ?? 'auto',
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? `${trimmed}/${bucket}`).replace(/\/+$/, ''),
  };
}

// One client per distinct credential set (env can change between calls in tests).
const clients = new Map<string, S3Client>();

function client(env: S3Env): S3Client {
  const id = `${env.endpoint}|${env.region}|${env.accessKeyId}`;
  let c = clients.get(id);
  if (!c) {
    c = new S3Client({
      endpoint: env.endpoint,
      region: env.region,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      forcePathStyle: true,
    });
    clients.set(id, c);
  }
  return c;
}

function assertKey(key: string): void {
  if (!isSafeKey(key)) {
    throw new StorageError('Invalid storage key.');
  }
}

function s3Storage(env: S3Env): AppStorage {
  return {
    driver: 's3',

    async save(key, data) {
      assertKey(key);
      await client(env).send(
        new PutObjectCommand({ Bucket: env.bucket, Key: key, Body: data, ContentType: contentTypeForKey(key) }),
      );
    },

    async remove(key) {
      assertKey(key);
      await client(env).send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
    },

    async removePrefix(prefix) {
      if (!isSafeKey(prefix)) {
        return 0;
      }
      const s3 = client(env);
      let count = 0;
      let token: string | undefined;
      do {
        const listed = await s3.send(
          new ListObjectsV2Command({ Bucket: env.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const objects = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (objects.length > 0) {
          await s3.send(new DeleteObjectsCommand({ Bucket: env.bucket, Delete: { Objects: objects } }));
          count += objects.length;
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      return count;
    },

    url(key) {
      return `${env.publicBaseUrl}/${key}`;
    },

    async presignPut(key, contentType) {
      assertKey(key);
      const url = await getSignedUrl(
        client(env),
        new PutObjectCommand({ Bucket: env.bucket, Key: key, ContentType: contentType }),
        { expiresIn: PRESIGN_TTL_SECONDS },
      );
      return { url, key };
    },
  };
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

/**
 * The driver for THIS call, from env. `STORAGE_DRIVER` wins when set;
 * otherwise a complete S3_* set selects s3, anything else is local.
 */
export function getStorage(): AppStorage {
  const forced = (process.env.STORAGE_DRIVER ?? '').toLowerCase();
  if (forced === 'local') {
    return localStorage;
  }
  const env = s3Env();
  if (env !== null) {
    return s3Storage(env);
  }
  if (forced === 's3') {
    throw new StorageError(
      'STORAGE_DRIVER=s3 but S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are not all set.',
    );
  }
  return localStorage;
}

/** Human-readable summary for a Settings / diagnostics screen. */
export function storageInfo(): { driver: 'local' | 's3'; detail: string } {
  const env = getStorage().driver === 's3' ? s3Env() : null;
  if (env === null) {
    return { driver: 'local', detail: uploadsRoot() };
  }
  return { driver: 's3', detail: `${env.endpoint}/${env.bucket} (cdn: ${env.publicBaseUrl})` };
}

// Re-exported so file routes can stream local files without importing node:fs.
export { createReadStream, resolveLocalPath as localPathForKey };
