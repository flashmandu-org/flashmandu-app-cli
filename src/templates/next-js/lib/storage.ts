/* @flashmandu-template lib/storage.ts@0.5.1 */
/**
 * App file storage — one interface, two drivers, picked per call from env.
 *
 *   local (default) — files under `data/uploads/` (override with UPLOADS_DIR;
 *     tests point it at a tmp dir). Served by YOUR app's own file route at
 *     `/api/files/<key>`, which must re-check the owning row is allowed to be
 *     public before streaming (use `localPathForKey` + `createReadStream`).
 *   s3 — active when S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
 *     set plus either S3_ENDPOINT (R2, MinIO: `https://<acct>.r2.cloudflare
 *     storage.com`, S3_REGION=auto) or a real S3_REGION alone (AWS, e.g.
 *     ap-south-1, SDK default endpoint). The browser uploads straight to a
 *     presigned PUT URL.
 *   BUCKETS ARE NEVER PUBLIC (owner, 2026-10-28): AWS Block Public Access stays
 *     on and R2 stays private. With no S3_PUBLIC_BASE_URL the s3 driver is in
 *     PRIVATE mode (the default): `url(key)` is the app's own gated route
 *     `/api/files/<key>`, which streams through `get()` (GetObject, Range
 *     passed through). S3_PUBLIC_BASE_URL set = CDN mode, `url()` points there.
 *   STORAGE_DRIVER=local|s3 forces a driver; a forced s3 with an incomplete
 *     S3_* set throws instead of silently writing to local disk.
 *
 * KEYS. Build every key under `profilePrefix(profileId)` (`p<id>/...`) so a
 * profile's files are ONE prefix: the uninstall / GDPR purge is then a single
 * `removePrefix(profilePrefix(id))`. Keys are strict relative paths
 * (`isSafeKey`); that charset rule is the local driver's traversal defence.
 *
 * AWS SDK. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` are loaded
 * LAZILY, on the first S3 call only, through a specifier neither TypeScript
 * nor the bundler resolves at build time. So an app that never configures S3
 * (or an older app `upgrade` just added this file to) builds and runs with
 * neither package installed; configuring S3 without them is a clear
 * StorageError naming the packages, not a broken build.
 *
 * Server-only. No browser-exposed env var: every value is resolved server-side.
 * Vendored byte-for-byte by apps built before the starter shipped it (Tours);
 * change it HERE and re-vendor, never fork a copy.
 */

import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';


/** Presigned PUT lifetime, seconds. */
export const PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * `invalid` — the caller asked for something wrong (bad key, misconfigured
 *   driver choice); the message is safe to show.
 * `unavailable` — storage itself is not usable (unwritable disk, no S3 env on
 *   the pod). The message is the fixed, human STORAGE_UNAVAILABLE_MESSAGE;
 *   the real errno and path go to the server log only, never to a person.
 */
export type StorageErrorCode = 'invalid' | 'unavailable';

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: StorageErrorCode = 'invalid',
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** What a person sees when storage is not set up. Apps may word their own from `code`. */
export const STORAGE_UNAVAILABLE_MESSAGE = "File storage isn't set up for this app yet.";

/** fs errors that mean "this disk cannot take our files", not "this request was wrong". */
const UNAVAILABLE_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

function unavailable(cause: unknown): StorageError {
  console.error('[storage] local storage is not writable', cause);
  return new StorageError(STORAGE_UNAVAILABLE_MESSAGE, 'unavailable');
}

function isUnavailableErrno(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UNAVAILABLE_ERRNOS.has(code);
}

export interface PresignedUpload {
  /** Where the browser PUTs the file bytes. */
  url: string;
  /** The storage key the object will land under (echoed back to the client). */
  key: string;
}

/** One stored object, ready to stream from a file route. */
export interface StoredObject {
  /** 200 whole object, 206 a byte range, 416 the range cannot be satisfied (no body). */
  status: 200 | 206 | 416;
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  /** Bytes in THIS response (the range length for a 206). */
  contentLength: number;
  /** `bytes a-b/size` for a 206; `bytes STAR/size` (STAR = a literal asterisk) for a 416. */
  contentRange?: string;
  etag?: string;
  lastModified?: Date;
}

export interface AppStorage {
  readonly driver: 'local' | 's3';
  /**
   * True when `url()` is the app's own gated route rather than a public
   * address: always for local, and for s3 unless S3_PUBLIC_BASE_URL is set.
   */
  readonly private: boolean;
  /** Persist `data` under `key`, creating parent directories as needed. */
  save(key: string, data: Buffer): Promise<void>;
  /** Remove `key`. A missing object is NOT an error (purge idempotency). */
  remove(key: string): Promise<void>;
  /**
   * Remove every object under `prefix` and return how many were removed. Only
   * a tenant prefix (`isTenantPrefix`) is honoured; anything else removes
   * nothing.
   */
  removePrefix(prefix: string): Promise<number>;
  /** The URL the storefront / admin preview reads the file from. */
  url(key: string): string;
  /** Presign a browser-direct PUT. The local driver refuses (upload through your own route). */
  presignPut(key: string, contentType: string): Promise<PresignedUpload>;
  /**
   * Read `key` for a file route, honouring an HTTP `Range` header value
   * (`bytes=a-b`, `bytes=a-`, `bytes=-n`). Null when the key is unsafe or the
   * object does not exist. Your route still owns every access gate.
   */
  get(key: string, opts?: { range?: string | null }): Promise<StoredObject | null>;
}

/**
 * Resolve one `bytes=` range against `size`: `[start, end]` inclusive, null
 * for "serve the whole object" (no/odd header, multi-range), or 'unsatisfiable'.
 */
export function parseByteRange(header: string | null | undefined, size: number): [number, number] | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return [start, end];
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

/**
 * True for a prefix `removePrefix` may delete: a profile folder `p<id>/` or a
 * folder inside one (`p<id>/a7/`), always slash-terminated. One rule for both
 * drivers, so a bug can never purge the bucket root, another tenant's
 * look-alike prefix (`p1` would also match `p12/` on S3) or a half key.
 */
export function isTenantPrefix(prefix: string): boolean {
  return /^p\d+\/(.+\/)?$/.test(prefix) && isSafeKey(prefix);
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
  private: true,

  async save(key, data) {
    const abs = resolveLocalPath(key);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, data);
    } catch (err) {
      throw isUnavailableErrno(err) ? unavailable(err) : err;
    }
  },

  async remove(key) {
    await fs.rm(resolveLocalPath(key), { force: true });
  },

  async removePrefix(prefix) {
    if (!isTenantPrefix(prefix)) {
      return 0;
    }
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

  async get(key, opts) {
    let abs: string;
    try {
      abs = resolveLocalPath(key);
    } catch {
      return null;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const size = stat.size;
    const base = {
      contentType: contentTypeForKey(key),
      etag: `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
      lastModified: stat.mtime,
    };
    const range = parseByteRange(opts?.range, size);
    if (range === 'unsatisfiable') {
      return { ...base, status: 416, body: null, contentLength: 0, contentRange: `bytes */${size}` };
    }
    const [start, end] = range ?? [0, size - 1];
    const body = Readable.toWeb(createReadStream(abs, size === 0 ? {} : { start, end })) as ReadableStream<Uint8Array>;
    return range === null
      ? { ...base, status: 200, body, contentLength: size }
      : { ...base, status: 206, body, contentLength: end - start + 1, contentRange: `bytes ${start}-${end}/${size}` };
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

/**
 * The S3 settings from env, or null when incomplete. Two shapes:
 *   R2 / MinIO — S3_ENDPOINT (`https://<acct>.r2.cloudflarestorage.com`),
 *     S3_REGION `auto` (the default), path-style addressing.
 *   AWS — no S3_ENDPOINT, a real S3_REGION (`ap-south-1`); the SDK picks the
 *     regional endpoint and virtual-hosted addressing.
 * `publicBaseUrl` is '' (PRIVATE mode, the default) unless S3_PUBLIC_BASE_URL
 * names a CDN in front of the bucket.
 */
export function s3Config(): S3Env | null {
  const endpoint = (process.env.S3_ENDPOINT ?? '').replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET ?? '';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
  const region = process.env.S3_REGION ?? 'auto';
  if (bucket === '' || accessKeyId === '' || secretAccessKey === '') {
    return null;
  }
  if (endpoint === '' && (region === '' || region === 'auto')) {
    return null;
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
  };
}

// Structural slice of the AWS SDK this driver uses (the real types are not
// required at build time; see "AWS SDK" above).
type S3CommandCtor = new (input: Record<string, unknown>) => unknown;
interface S3ClientLike {
  send(command: unknown): Promise<{
    Contents?: Array<{ Key?: string }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
    Body?: { transformToWebStream(): ReadableStream<Uint8Array> };
    ContentType?: string;
    ContentLength?: number;
    ContentRange?: string;
    ETag?: string;
    LastModified?: Date;
  }>;
}
interface S3Sdk {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: S3CommandCtor;
  DeleteObjectCommand: S3CommandCtor;
  DeleteObjectsCommand: S3CommandCtor;
  ListObjectsV2Command: S3CommandCtor;
  GetObjectCommand: S3CommandCtor;
  getSignedUrl(client: S3ClientLike, command: unknown, options: { expiresIn: number }): Promise<string>;
}

// Non-literal on purpose: a literal would make tsc and the bundler require
// the packages at build time.
const AWS_S3_CLIENT = '@aws-sdk/client-s3';
const AWS_S3_PRESIGNER = '@aws-sdk/s3-request-presigner';

let sdkPromise: Promise<S3Sdk> | null = null;

function loadSdk(): Promise<S3Sdk> {
  sdkPromise ??= Promise.all([
    import(/* webpackIgnore: true */ AWS_S3_CLIENT),
    import(/* webpackIgnore: true */ AWS_S3_PRESIGNER),
  ]).then(
    ([client, presigner]) => ({ ...client, getSignedUrl: presigner.getSignedUrl }) as S3Sdk,
    () => {
      sdkPromise = null;
      throw new StorageError(
        `S3 storage is configured but ${AWS_S3_CLIENT} and ${AWS_S3_PRESIGNER} are not installed. ` +
          'Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
      );
    },
  );
  return sdkPromise;
}

// One client per distinct credential set (env can change between calls in tests).
const clients = new Map<string, S3ClientLike>();

async function client(env: S3Env): Promise<{ sdk: S3Sdk; s3: S3ClientLike }> {
  const sdk = await loadSdk();
  const id = `${env.endpoint}|${env.region}|${env.accessKeyId}`;
  let s3 = clients.get(id);
  if (!s3) {
    // R2/MinIO: explicit endpoint, path-style. AWS: no endpoint (the SDK
    // derives the regional one), virtual-hosted style.
    s3 = new sdk.S3Client({
      ...(env.endpoint !== '' ? { endpoint: env.endpoint } : {}),
      region: env.region,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      forcePathStyle: env.endpoint !== '',
    });
    clients.set(id, s3);
  }
  return { sdk, s3 };
}

function assertKey(key: string): void {
  if (!isSafeKey(key)) {
    throw new StorageError('Invalid storage key.');
  }
}

function s3Storage(env: S3Env): AppStorage {
  return {
    driver: 's3',
    private: env.publicBaseUrl === '',

    async save(key, data) {
      assertKey(key);
      const { sdk, s3 } = await client(env);
      await s3.send(
        new sdk.PutObjectCommand({ Bucket: env.bucket, Key: key, Body: data, ContentType: contentTypeForKey(key) }),
      );
    },

    async remove(key) {
      assertKey(key);
      const { sdk, s3 } = await client(env);
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
    },

    async removePrefix(prefix) {
      if (!isTenantPrefix(prefix)) {
        return 0;
      }
      const { sdk, s3 } = await client(env);
      let count = 0;
      let token: string | undefined;
      do {
        const listed = await s3.send(
          new sdk.ListObjectsV2Command({ Bucket: env.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const objects = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (objects.length > 0) {
          await s3.send(new sdk.DeleteObjectsCommand({ Bucket: env.bucket, Delete: { Objects: objects } }));
          count += objects.length;
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      return count;
    },

    url(key) {
      // PRIVATE (default): the app's own gated route streams it via get().
      return env.publicBaseUrl === '' ? `/api/files/${key}` : `${env.publicBaseUrl}/${key}`;
    },

    async get(key, opts) {
      if (!isSafeKey(key)) return null;
      const { sdk, s3 } = await client(env);
      const range = opts?.range ? opts.range.trim() : '';
      let out;
      try {
        out = await s3.send(
          new sdk.GetObjectCommand({ Bucket: env.bucket, Key: key, ...(range !== '' ? { Range: range } : {}) }),
        );
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        if (e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416) {
          return { status: 416, body: null, contentType: contentTypeForKey(key), contentLength: 0 };
        }
        throw err;
      }
      return {
        status: out.ContentRange ? 206 : 200,
        body: out.Body ? out.Body.transformToWebStream() : null,
        contentType: out.ContentType ?? contentTypeForKey(key),
        contentLength: out.ContentLength ?? 0,
        ...(out.ContentRange ? { contentRange: out.ContentRange } : {}),
        ...(out.ETag ? { etag: out.ETag } : {}),
        ...(out.LastModified ? { lastModified: out.LastModified } : {}),
      };
    },

    async presignPut(key, contentType) {
      assertKey(key);
      const { sdk, s3 } = await client(env);
      const url = await sdk.getSignedUrl(
        s3,
        new sdk.PutObjectCommand({ Bucket: env.bucket, Key: key, ContentType: contentType }),
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
  const env = s3Config();
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

/**
 * Fail FAST, before any work, when the active driver cannot store a file:
 * the local driver must be able to create and write its uploads root (on a
 * pod with no S3 env that root is usually read-only). Throws a StorageError
 * with code `unavailable` and STORAGE_UNAVAILABLE_MESSAGE; the s3 driver is
 * a no-op (its credentials are checked by the first real call). Call it at
 * the top of every route that is about to accept or fetch a file.
 */
export async function assertStorageWritable(): Promise<void> {
  if (getStorage().driver !== 'local') {
    return;
  }
  const root = uploadsRoot();
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.access(root, fsConstants.W_OK);
  } catch (err) {
    throw unavailable(err);
  }
}

/** Human-readable summary for a Settings / diagnostics screen. */
export function storageInfo(): { driver: 'local' | 's3'; detail: string } {
  const env = getStorage().driver === 's3' ? s3Config() : null;
  if (env === null) {
    return { driver: 'local', detail: uploadsRoot() };
  }
  const where = env.endpoint !== '' ? `${env.endpoint}/${env.bucket}` : `s3://${env.bucket} (${env.region})`;
  return {
    driver: 's3',
    detail: env.publicBaseUrl === '' ? `${where} (private: served by the app)` : `${where} (cdn: ${env.publicBaseUrl})`,
  };
}

// Re-exported so file routes can stream local files without importing node:fs.
export { createReadStream, resolveLocalPath as localPathForKey };
