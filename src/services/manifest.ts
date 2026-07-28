import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as TOML from '@iarna/toml';
import { z } from 'zod';

/**
 * Zod schema and reader for `flashmandu.app.toml` — the manifest a developer
 * authors at the root of an app repo. The CLI reads this in `app dev`,
 * `app push`, and `app init`.
 *
 * The shape mirrors the host's remote_apps config entry and the SDK's
 * AppManifest: an id, name, version, the OAuth URLs the host will redirect
 * merchants to, the scopes the app requests, and the events it wants
 * delivered to its webhook_url.
 */

const SCOPE_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * App ids are kebab-case, optionally namespaced with a single slash
 * (`acme/loyalty`, `dev/cli`) — matching the host's remote-app id format.
 * Shared with the `init` prompt so scaffold-time and dev-time validation
 * can never disagree.
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9](\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9])?$/;

export const ManifestSchema = z.object({
  id: z
    .string()
    .regex(APP_ID_RE, 'id must be lowercase kebab-case, 3-80 chars (e.g. "acme/loyalty")'),
  name: z.string().min(1).max(120),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'version must be semver X.Y.Z'),
  description: z.string().max(2000).optional(),

  /** Absolute https URLs on the app's own server. */
  authorize_url: z.string().url(),
  token_url: z.string().url(),
  /** App URL that receives signed platform webhooks. */
  webhook_url: z.string().url(),
  /** Optional separate credential delivery URL (defaults to token_url). */
  credential_delivery_url: z.string().url().optional(),

  /** Uppercase Scope enum values from flashmandu/app-sdk. */
  scopes: z.array(z.string().regex(SCOPE_RE)).default([]),

  /** Hook names from `app hooks` that the app wants delivered. */
  subscribed_events: z.array(z.string().min(1)).default([]),

  /** Optional developer metadata for marketplace submission. */
  developer_name: z.string().max(120).optional(),
  developer_email: z.string().email().max(150).optional(),
  source_url: z.string().url().max(255).optional(),
  provider_class: z.string().max(255).optional(),
});

export type AppManifest = z.infer<typeof ManifestSchema>;

export const MANIFEST_FILENAME = 'flashmandu.app.toml';

/** Read and validate the manifest from `dir`. Throws on malformed TOML/schema. */
export async function readManifest(dir: string): Promise<AppManifest> {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No ${MANIFEST_FILENAME} found in ${dir}. Run \`flashmandu-app init\` first.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${MANIFEST_FILENAME}: ${msg}`);
  }

  return ManifestSchema.parse(parsed);
}

/** Serialize a manifest to TOML (used by `app init`). */
export function serializeManifest(m: AppManifest): string {
  return TOML.stringify(m as unknown as TOML.JsonMap);
}
