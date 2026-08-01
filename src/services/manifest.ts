import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as TOML from '@iarna/toml';
import { z } from 'zod';

/**
 * Zod schema and reader for `flashmandu.app.toml` — the manifest a developer
 * authors at the root of an app repo. The CLI reads this in `app dev`,
 * `app push`, and `app init`.
 *
 * Identity model: the platform uses a publisher-namespaced canonical id of the
 * form `<publisher>/<slug>` (e.g. `acme/loyalty`). The developer only ever
 * authors the leaf — `slug` — and the host namespaces it by publisher when it
 * derives the canonical app id. The CLI therefore sends `slug` in register
 * payloads and receives the canonical `app_id` back in the response.
 *
 * For back-compat with existing manifests, a legacy `id` (kebab-case,
 * optionally namespaced with a single slash) is still accepted as an alias:
 * if `slug` is absent, the leaf after any `/` is used as the slug.
 */

const SCOPE_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * App slugs are the developer-chosen leaf of the canonical
 * `<publisher>/<slug>` app id. Lowercase alphanumeric + dashes, 1-96 chars.
 * Shared with the `init` prompt so scaffold-time and dev-time validation can
 * never disagree.
 */
export const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Legacy app ids were kebab-case, optionally namespaced with a single slash
 * (`acme/loyalty`, `dev/cli`) — matching the host's old remote-app id format.
 * Retained as an optional alias; the slug is derived from the leaf after any
 * `/`.
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9](\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9])?$/;

export const SlugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(APP_SLUG_RE, 'slug must be alphanumeric + dashes (e.g. "my-app")');

export type AppManifest = {
  /** Resolved developer-chosen leaf of `<publisher>/<slug>`. Always present. */
  slug: string;
  /** Legacy alias; retained for back-compat with existing manifests. */
  id?: string;
  name: string;
  version: string;
  description?: string;
  /** Absolute https URLs on the app's own server. */
  authorize_url: string;
  token_url: string;
  /** App URL that receives signed platform webhooks. */
  webhook_url: string;
  /** Optional separate credential delivery URL (defaults to token_url). */
  credential_delivery_url?: string;
  /** Uppercase Scope enum values from flashmandu/app-sdk. */
  scopes: string[];
  /** Hook names from `app hooks` that the app wants delivered. */
  subscribed_events: string[];
  /** Optional developer metadata for marketplace submission. */
  developer_name?: string;
  developer_email?: string;
  source_url?: string;
  provider_class?: string;
  /** Where the production build is hosted: 'vercel' | 'self'. Set by `deploy`. */
  hosting_target?: string;
  /** Optional App Embed Blocks declared in the manifest (Spec #1). Sent to the
   * host at dev-register so it persists them on `installed_apps.extensions`. */
  embed_blocks?: EmbedBlock[];
  /** App-declared sidebar nav items (Spec #2 §S6). Sent to the host at
   * dev-register so it renders them in the storefront sidebar. */
  nav_items?: NavItem[];
};

/**
 * A storefront App Embed Block declared under `[[embed_blocks]]` in the
 * manifest (Spec #1). Mirrors the host SDK `EmbedBlockDefinition` shape.
 */
export interface EmbedBlockSetting {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  help?: string;
  default?: string | number | boolean | null;
  /** Static select options: { value, label }. */
  options?: Array<{ value: string; label: string }>;
  /** Dynamic options sourced from the app ('app'). */
  dynamic_options_source?: string;
  /** Path under the app host that serves the dynamic options list. */
  dynamic_options_path?: string;
}

export interface EmbedBlock {
  type: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  /** 'remote' (default) or 'trusted' (platform-managed co-located origin). */
  hosting_tier?: string;
  /** Path under the app host the platform iframes. */
  block_path: string;
  /** Subset of [identity, resize, navigate, error]. */
  capabilities?: string[];
  /** Platform scopes required (usually empty for storefront-only blocks). */
  scopes?: string[];
  schema_version?: number;
  /** Merchant-configurable fields for the block. */
  settings?: EmbedBlockSetting[];
}

/**
 * A developer-declared sidebar nav entry under `[[nav_items]]` in the manifest
 * (Spec #2 §S6). The host renders these in the storefront sidebar for installed
 * apps. `path` is app-relative and must start with "/".
 */
export interface NavItem {
  label: string;
  path: string;
  icon?: string;
  order?: number;
}

const EmbedBlockSettingSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().optional(),
  help: z.string().max(500).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
  dynamic_options_source: z.string().optional(),
  dynamic_options_path: z.string().optional(),
});

const EmbedBlockSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().max(1000).optional(),
  category: z.string().max(60).optional(),
  icon: z.string().max(60).optional(),
  hosting_tier: z.enum(['remote', 'trusted']).default('remote'),
  block_path: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().regex(SCOPE_RE)).default([]),
  schema_version: z.number().int().min(1).default(1),
  settings: z.array(EmbedBlockSettingSchema).default([]),
});

const NavItemSchema = z.object({
  label: z.string().min(1).max(80),
  path: z.string().min(1).max(200).regex(/^\//, 'path must start with "/"'),
  icon: z.string().max(60).optional(),
  order: z.number().int().min(0).optional(),
});

const ManifestInput = z.object({
  slug: SlugSchema.optional(),
  id: z
    .string()
    .regex(APP_ID_RE, 'id must be lowercase kebab-case, 3-80 chars (e.g. "acme/loyalty")')
    .optional(),
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver X.Y.Z'),
  description: z.string().max(2000).optional(),
  authorize_url: z.string().url(),
  token_url: z.string().url(),
  webhook_url: z.string().url(),
  credential_delivery_url: z.string().url().optional(),
  scopes: z.array(z.string().regex(SCOPE_RE)).default([]),
  subscribed_events: z.array(z.string().min(1)).default([]),
  developer_name: z.string().max(120).optional(),
  developer_email: z.string().email().max(150).optional(),
  source_url: z.string().url().max(255).optional(),
  provider_class: z.string().max(255).optional(),
  embed_blocks: z.array(EmbedBlockSchema).optional(),
  nav_items: z.array(NavItemSchema).optional(),
});

export const ManifestSchema = ManifestInput.superRefine((m, ctx): void => {
  if (!m.slug && !m.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'manifest must declare `slug` (or legacy `id`) — the developer-chosen leaf of <publisher>/<slug>',
      path: ['slug'],
    });
  }
}).transform((m): AppManifest => {
  const slug = m.slug ?? deriveSlugFromId(m.id)!;
  // Re-validate the derived slug so a malformed legacy id surfaces a clear
  // error rather than silently producing an invalid register payload.
  const result = SlugSchema.safeParse(slug);
  if (!result.success) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['slug'],
        message: `derived slug "${slug}" must be alphanumeric + dashes (1-96 chars)`,
      },
    ]);
  }
  return { ...m, slug: result.data };
});

/**
 * Derive the slug (leaf) from a legacy namespaced id. `acme/loyalty` →
 * `loyalty`; `my-app` → `my-app`. Returns undefined when id is absent.
 */
export function deriveSlugFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.includes('/') ? (id.split('/').pop() ?? id) : id;
}

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

/**
 * Bump a semver patch: 0.1.0 -> 0.1.1. Falls back to appending `.1` for a
 * version that is not three numeric parts, so a non-standard version still
 * moves forward rather than silently resubmitting the same one.
 */
export function bumpPatch(version: string): string {
  const parts = version.trim().split('.');
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  }

  return `${version.trim()}.1`;
}

/**
 * Rewrite top-level scalar keys in the manifest IN PLACE, preserving comments,
 * ordering and formatting.
 *
 * A full TOML re-serialize (serializeManifest) would flatten the file and drop
 * every comment the template ships with, so this edits only the lines it owns
 * and appends keys that do not exist yet.
 */
export async function updateManifestFields(
  dir: string,
  fields: Record<string, string>,
): Promise<void> {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw = await fs.readFile(file, 'utf8');

  for (const [key, value] of Object.entries(fields)) {
    const line = `${key} = ${JSON.stringify(value)}`;
    // Only match the key at top level (start of line, before any [table]).
    const re = new RegExp(`^${key}\\s*=.*$`, 'm');

    if (re.test(raw)) {
      raw = raw.replace(re, line);
      continue;
    }

    // Place the key with the OTHER top-level keys: directly after the last
    // `key = value` line that precedes the first table. Inserting immediately
    // before the table header instead parked new keys underneath whatever
    // comment block introduced that table, reading as if they belonged to it.
    const lines = raw.split('\n');
    const firstTableIdx = lines.findIndex((l) => /^\s*\[/.test(l));
    const limit = firstTableIdx === -1 ? lines.length : firstTableIdx;

    let lastKeyIdx = -1;
    for (let i = 0; i < limit; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_-]*\s*=/.test(lines[i] ?? '')) lastKeyIdx = i;
    }

    lines.splice(lastKeyIdx === -1 ? limit : lastKeyIdx + 1, 0, line);
    raw = lines.join('\n');
  }

  await fs.writeFile(file, raw, 'utf8');
}
