import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as TOML from '@iarna/toml';
import { z } from 'zod';
import { validateSchedules, type ScheduleEntry } from './schedules';

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

/**
 * A platform scope, as the platform actually spells it: `<verb>:<resource>`,
 * lowercase.
 *
 * The values are the VALUES of the host's `Flashmandu\Apps\Ports\PortScope`
 * (and the SDK's `Flashmandu\AppSdk\Scope`, which mirrors it) — `read:media`,
 * `write:locations`, `send:notifications`, `broadcast:events`,
 * `manage:storefront`, and so on. This regex previously read
 * `/^[A-Z][A-Za-z0-9]*$/`, which is the shape of an enum CASE NAME (`ReadMedia`)
 * rather than its value, so `flashmandu.app.toml` was rejected with
 * `scopes.0: Invalid` for every app that declared a real scope — which is every
 * app that does anything. `dev`, `push` and `deploy` all validate the manifest
 * first, so the bug blocked all three.
 *
 * Deliberately a SHAPE check and not an allow-list of the ~20 known values: the
 * host owns the catalog and adds to it, and a CLI that hard-codes the list
 * would start rejecting valid manifests the day a scope ships. The host
 * validates membership at register time, which is the right place for it. The
 * hyphen branch is forward-tolerance for a future multi-word resource
 * (`read:price-lists`); nothing in the catalog uses one today.
 */
const SCOPE_RE = /^[a-z]+:[a-z]+(-[a-z]+)*$/;

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
  /** Where the production build is hosted: 'vercel' | 'self' | 'platform'. Set by `deploy`. */
  hosting_target?: string;
  /** Immutable sha256:<64 hex> digest of the image pushed by `deploy --target platform`.
   * A digest, never a tag — the platform refuses to approve a tag. */
  image_digest?: string;
  /** Optional App Embed Blocks declared in the manifest (Spec #1). Sent to the
   * host at dev-register so it persists them on `installed_apps.extensions`,
   * desugared into the unified extension shape. */
  embed_blocks?: EmbedBlock[];
  /**
   * The custom-property namespace every Style Surface variable this app
   * declares must live under, e.g. `--tours`. An APP-level fact, but the host
   * reads it back off each BLOCK's payload — `installed_apps.extensions` is
   * the only channel that survives, and there is no app-level column for it.
   * `buildExtensionPayload()` is what flattens it onto every pushed block.
   */
  style_var_prefix?: string;
  /** The version the app's style declarations were authored against. */
  style_schema_version?: number;
  /**
   * Unified `[[extensions]]` declarations — the one table for every host
   * surface. Either shape is accepted (see {@link ManifestExtension}); the
   * unified one is always what is sent.
   */
  extensions?: AnyManifestExtension[];
  /** App-declared sidebar nav items (Spec #2 §S6). Sent to the host at
   * dev-register so it renders them in the storefront sidebar. */
  nav_items?: NavItem[];
  /**
   * Declarative `[webhooks]` section. The CLI is the single writer of an app's
   * webhook subscription: `events` is synced into `subscribed_events` and
   * `url` overrides `webhook_url` on every `dev`/`push`/`deploy`.
   */
  webhooks?: WebhooksSection;
  /** Declarative `[[schedules]]` blocks synced alongside webhooks. */
  schedules?: ScheduleEntry[];
  /**
   * Tier 1 declarative storefront sections — `[[storefront_sections]]`. Each
   * entry either carries `element_tree` inline or names a `blueprint_file`
   * relative to the manifest for the CLI to inline at read/push time (see
   * {@link resolveStorefrontSections}). The host never reads `blueprint_file`
   * itself — {@see SectionDefinition::fromArray} only reads `element_tree`.
   */
  storefront_sections?: StorefrontSection[];
};

/**
 * One `[[storefront_sections]]` declaration, as authored in the manifest
 * (before `blueprint_file` is inlined into `element_tree`). Mirrors the host
 * SDK's `Flashmandu\AppSdk\Storefront\SectionDefinition`.
 */
export interface StorefrontSection {
  /** Stable key for this section within the app. Unique per install. */
  type: string;
  name: string;
  /** 'blueprint' (default, no server) | 'static' | 'endpoint' (Tier 2). */
  source?: 'blueprint' | 'static' | 'endpoint';
  category?: string;
  /**
   * Path (relative to the app directory) to a JSON file whose top-level
   * content IS the element tree — a JSON array of composable node objects.
   * `section dev` reads and inlines it into `element_tree` before every push;
   * the host's SDK docs it explicitly: it only ever reads `element_tree`.
   */
  blueprint_file?: string;
  /** Inline element tree, when not sourced from `blueprint_file`. */
  element_tree?: Array<Record<string, unknown>>;
  /** Merchant-configurable fields, same shape as an embed block's. */
  settings?: EmbedBlockSetting[];
  /** Module/collection binding (Tier 1 §bindings) — passed through verbatim. */
  bindings?: Record<string, unknown>;
  /** Required when source is 'endpoint'. */
  endpoint_path?: string;
  schema_version?: number;
}

/**
 * The `[webhooks]` table in `flashmandu.app.toml`:
 *
 * ```toml
 * [webhooks]
 * url    = "https://app.example.com/webhooks/flashmandu"
 * events = ["order.created", "customer.updated"]
 * ```
 *
 * `url` is optional — when omitted the top-level `webhook_url` is used, which
 * is what `deploy` rewrites. Declaring it here wins, so an app that terminates
 * webhooks on a different host than its OAuth endpoints can say so.
 */
export interface WebhooksSection {
  url?: string;
  events: string[];
}

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

/**
 * One merchant-editable visual knob on a {@link StyleSurfaceDeclaration}.
 *
 * The value TYPES are shape-checked here, never allow-listed: the host owns the
 * closed vocabulary (`App\Services\Storefront\Themes\DesignTokenType`) and adds
 * to it, exactly like TARGET_RE and SCOPE_RE. What the CLI *does* enforce
 * locally is the namespace rule, because that one is a security boundary the
 * host refuses the whole block over — catching it at `push` time is far kinder
 * than an install-time "failed to hydrate" warning.
 */
export interface StyleSlotDeclaration {
  key: string;
  label?: string;
  description?: string;
  type: string;
  var: string;
  control?: string;
  default?: unknown;
  dark_default?: unknown;
  inherits?: string;
  themed?: boolean;
  replaces?: string;
  units?: string[];
  min?: number;
  max?: number;
  options?: Array<{ value: string; label?: string }>;
  families?: string[];
  max_layers?: number;
  allow_reference?: boolean;
}

/**
 * A named region of the app's own UI whose visuals a merchant may restyle from
 * the platform's page builder — `[[embed_blocks.style_surfaces]]`.
 */
export interface StyleSurfaceDeclaration {
  key: string;
  name: string;
  description?: string;
  preview_hint?: string;
  slots: StyleSlotDeclaration[];
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
  /** Merchant-editable VISUALS for the block (Style Surfaces). */
  style_surfaces?: StyleSurfaceDeclaration[];
}

/**
 * One `[[extensions.targeting]]` block: an extension saying "render me HERE,
 * THIS way".
 *
 * Mirrors the host's `Flashmandu\Apps\Extensions\TargetBinding`. One
 * extension may carry several — one extension, several surfaces, one codebase
 * — which is the entire reason the unified shape exists: a loyalty app wants an
 * admin block AND a POS action AND a storefront section without declaring
 * itself three times.
 */
export interface ExtensionTargeting {
  /** A host target string, e.g. `admin.order.detail.block`. */
  target: string;
  /** How the host renders it. Inferred by the host when omitted; declare it. */
  mode?: 'block' | 'iframe' | 'render-spec';
  /** Path under the app's origin (iframe / render-spec). */
  path?: string;
  /** Optional companion boolean endpoint that hides the block per resource. */
  should_render?: string;
  /** FQN/container key of an in-process BlockContribution (first-party only). */
  block?: string;
  /** Fully-resolved absolute URL, when the app serves this target elsewhere. */
  remote_url?: string;
}

/**
 * A unified `[[extensions]]` declaration — one manifest table for every surface
 * (UI extension surfaces spec §3.3).
 *
 * The host reads this through
 * `Flashmandu\Apps\Extensions\ExtensionDefinition::fromUnifiedPayload()`.
 * Two older shapes desugar INTO it and are still accepted here:
 *
 *  - a FLAT `[[extensions]]` block (`target` at the top level, no `targeting`),
 *    which is what the platform's REST register endpoint has always taken;
 *  - `[[embed_blocks]]`, the storefront-flavoured special case.
 *
 * Both are rewritten into this shape by `buildExtensionPayload()` before they
 * are sent, so the wire format is unified regardless of how the developer
 * authored it.
 */
export interface ManifestExtension {
  /** Stable key for this extension within the app. Its placement row's key. */
  handle: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  /** Calendar API version, e.g. "2026-08". Defaults platform-side. */
  api_version?: string;
  targeting: ExtensionTargeting[];
  /** Host capabilities requested. The SURFACE decides which are granted. */
  capabilities?: string[];
  /** Platform scopes required, as `<verb>:<resource>` values. */
  scopes?: string[];
  /** Port scopes required (same spelling; the host stores them together). */
  port_scopes?: string[];
  schema_version?: number;
  replaces?: string;
  /** 'remote' (default) or 'trusted' (platform-managed co-located origin). */
  hosting_tier?: string;
  /** Merchant-configurable fields, same shape as an embed block's. */
  settings?: EmbedBlockSetting[];
  /** Merchant-editable VISUALS, same shape as an embed block's. */
  style_surfaces?: StyleSurfaceDeclaration[];
}

/**
 * The FLAT `[[extensions]]` block that predates `targeting`. Accepted so
 * manifests in the wild keep working; desugared to a single-binding
 * {@link ManifestExtension} on the way out.
 */
export interface FlatManifestExtension {
  target: string;
  handle?: string;
  label?: string;
  icon?: string;
  api_version?: string;
  mode?: 'block' | 'iframe' | 'render-spec';
  path?: string;
  should_render?: string;
  block?: string;
  remote_url?: string;
  remoteUrl?: string;
  scopes?: string[];
  requiredScopes?: string[];
  port_scopes?: string[];
  requiredPortScopes?: string[];
  capabilities?: string[];
  settings?: EmbedBlockSetting[];
}

export type AnyManifestExtension = ManifestExtension | FlatManifestExtension;

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

/** A custom-property name: `--lowercase-with-dashes`. */
const CSS_VAR_RE = /^--[a-z0-9-]+$/;

/**
 * Slot value types are shape-checked, not allow-listed (see
 * {@link StyleSlotDeclaration}). `.passthrough()` keeps per-type constraint
 * keys the host understands and this CLI has never heard of — a new host type
 * must not need a CLI release before an app may declare it.
 */
const StyleSlotSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]+$/, 'style slot key must be lowercase alphanumeric with underscores'),
    label: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    type: z.string().min(1),
    var: z.string().regex(CSS_VAR_RE, 'style slot `var` must be a custom-property name such as --tours-card-bg'),
    control: z.string().max(60).optional(),
    inherits: z.string().regex(CSS_VAR_RE).optional(),
    themed: z.boolean().optional(),
    replaces: z.string().max(96).optional(),
  })
  .passthrough();

const StyleSurfaceSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_:]+$/, 'style surface key must be lowercase alphanumeric with underscores (an admin surface may use an "admin:" prefix)'),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  preview_hint: z.string().max(120).optional(),
  slots: z.array(StyleSlotSchema).default([]),
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
  style_surfaces: z.array(StyleSurfaceSchema).optional(),
});

/**
 * Target strings are SHAPE-checked, never allow-listed. The host owns the
 * vocabulary (`ExtensionTargets::all()` is the SDK enum plus host-only
 * additions plus generated `should-render` companions) and adds to it; a CLI
 * that hard-coded the list would start rejecting valid manifests the day a new
 * surface ships. The host refuses an unknown target at hydration, which is the
 * right place for it — same posture as SCOPE_RE.
 */
const TARGET_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

const ExtensionModeSchema = z.enum(['block', 'iframe', 'render-spec']);

const TargetingSchema = z.object({
  target: z.string().regex(TARGET_RE, 'target must look like "admin.order.detail.block"'),
  mode: ExtensionModeSchema.optional(),
  path: z.string().min(1).optional(),
  should_render: z.string().min(1).optional(),
  block: z.string().min(1).optional(),
  remote_url: z.string().url().optional(),
});

const UnifiedExtensionSchema = z.object({
  handle: z.string().min(1).max(96),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  category: z.string().max(60).optional(),
  icon: z.string().max(60).optional(),
  api_version: z.string().max(32).optional(),
  targeting: z.array(TargetingSchema).min(1, 'an extension must declare at least one [[extensions.targeting]] block'),
  capabilities: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().regex(SCOPE_RE)).default([]),
  port_scopes: z.array(z.string().regex(SCOPE_RE)).default([]),
  schema_version: z.number().int().min(1).default(1),
  replaces: z.string().min(1).max(96).optional(),
  hosting_tier: z.enum(['remote', 'trusted']).default('remote'),
  settings: z.array(EmbedBlockSettingSchema).default([]),
  style_surfaces: z.array(StyleSurfaceSchema).optional(),
});

/**
 * The flat shape, kept working verbatim. `remoteUrl` / `requiredScopes` /
 * `requiredPortScopes` are the camelCase spellings the host's
 * `fromLegacyExtensionPayload()` reads, so both spellings are accepted rather
 * than forcing a manifest edit on anyone who copied the payload format.
 */
const FlatExtensionSchema = z.object({
  target: z.string().regex(TARGET_RE, 'target must look like "admin.order.detail.block"'),
  handle: z.string().min(1).max(96).optional(),
  label: z.string().max(120).optional(),
  icon: z.string().max(60).optional(),
  api_version: z.string().max(32).optional(),
  mode: ExtensionModeSchema.optional(),
  path: z.string().min(1).optional(),
  should_render: z.string().min(1).optional(),
  block: z.string().min(1).optional(),
  remote_url: z.string().url().optional(),
  remoteUrl: z.string().url().optional(),
  scopes: z.array(z.string().regex(SCOPE_RE)).optional(),
  requiredScopes: z.array(z.string().regex(SCOPE_RE)).optional(),
  port_scopes: z.array(z.string().regex(SCOPE_RE)).optional(),
  requiredPortScopes: z.array(z.string().regex(SCOPE_RE)).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  settings: z.array(EmbedBlockSettingSchema).optional(),
});

/**
 * Discriminated by the presence of `targeting`, exactly as the host's
 * `ExtensionManifestReader::hydrate()` discriminates the persisted payload.
 * Keeping the two discriminators identical is what stops a manifest from
 * parsing as one shape here and hydrating as the other there.
 */
const ExtensionSchema = z.union([UnifiedExtensionSchema, FlatExtensionSchema]);

const NavItemSchema = z.object({
  label: z.string().min(1).max(80),
  path: z.string().min(1).max(200).regex(/^\//, 'path must start with "/"'),
  icon: z.string().max(60).optional(),
  order: z.number().int().min(0).optional(),
});

const WebhooksSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).default([]),
});

const ScheduleSchema = z.object({
  name: z.string().min(1).max(64),
  every: z.string().min(1).max(16).optional(),
  cron: z.string().min(1).max(120).optional(),
});

/**
 * `[[storefront_sections]]`. Deliberately lenient on `element_tree` and
 * `bindings` shape — the platform's `AppSectionValidator` is the real gate
 * (it walks node types against its own catalog and rejects with a node path),
 * and the CLI must not maintain a second copy of that catalog that could
 * drift from the renderer. What IS enforced here is the same posture as
 * everywhere else in this file: shape, not vocabulary.
 */
const StorefrontSectionSchema = z
  .object({
    type: z.string().min(1).max(191),
    name: z.string().min(1).max(191),
    source: z.enum(['blueprint', 'static', 'endpoint']).default('blueprint'),
    category: z.string().max(120).optional(),
    blueprint_file: z.string().min(1).optional(),
    element_tree: z.array(z.record(z.string(), z.unknown())).optional(),
    settings: z.array(EmbedBlockSettingSchema).optional(),
    bindings: z.record(z.string(), z.unknown()).optional(),
    endpoint_path: z.string().min(1).optional(),
    schema_version: z.number().int().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.source === 'endpoint' && (!s.endpoint_path || s.endpoint_path.trim() === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `storefront_sections "${s.type}": source 'endpoint' requires 'endpoint_path'`,
        path: ['endpoint_path'],
      });
    }
    if (s.source === 'blueprint' && !s.blueprint_file && !s.element_tree) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `storefront_sections "${s.type}": source 'blueprint' requires 'blueprint_file' or an inline 'element_tree'`,
        path: ['blueprint_file'],
      });
    }
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
  hosting_target: z.enum(['vercel', 'self', 'platform']).optional(),
  image_digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'image_digest must be sha256:<64 hex> (a digest, never a tag)')
    .optional(),
  embed_blocks: z.array(EmbedBlockSchema).optional(),
  style_var_prefix: z.string().regex(CSS_VAR_RE, 'style_var_prefix must be a custom-property prefix such as --tours').optional(),
  style_schema_version: z.number().int().min(1).optional(),
  extensions: z.array(ExtensionSchema).optional(),
  nav_items: z.array(NavItemSchema).optional(),
  webhooks: WebhooksSchema.optional(),
  // Deliberately uncapped here: the MAX_SCHEDULES rule is enforced in the
  // superRefine below so the developer gets the platform's own wording rather
  // than a generic "array too long".
  schedules: z.array(ScheduleSchema).optional(),
  storefront_sections: z.array(StorefrontSectionSchema).optional(),
});

/**
 * The two rules the host refuses a whole block over, checked here so a
 * developer sees them at `push` time instead of as an install-time
 * "failed to hydrate" warning:
 *
 *  1. declaring style surfaces without an app-level `style_var_prefix`;
 *  2. a slot `var` outside that prefix — most sharply, one under `--fm-`,
 *     which would repaint the platform kit for the whole embed rather than
 *     the app's own card.
 *
 * Mirrors `Flashmandu\Apps\Extensions\StyleSlot::assertVarInNamespace()`.
 */
function validateStyleSurfaces(m: {
  style_var_prefix?: string;
  embed_blocks?: Array<{ type?: string; style_surfaces?: unknown }>;
  extensions?: Array<{ handle?: string; style_surfaces?: unknown }>;
}): string[] {
  const messages: string[] = [];
  const prefix = (m.style_var_prefix ?? '').trim();

  const declarations: Array<{ owner: string; surfaces: StyleSurfaceDeclaration[] }> = [];
  for (const block of m.embed_blocks ?? []) {
    if (Array.isArray(block.style_surfaces) && block.style_surfaces.length > 0) {
      declarations.push({ owner: block.type ?? 'embed_blocks', surfaces: block.style_surfaces });
    }
  }
  for (const extension of m.extensions ?? []) {
    if (Array.isArray(extension.style_surfaces) && extension.style_surfaces.length > 0) {
      declarations.push({ owner: extension.handle ?? 'extensions', surfaces: extension.style_surfaces });
    }
  }

  if (declarations.length === 0) {
    return messages;
  }

  if (prefix === '') {
    return ['an app that declares style surfaces must also declare app-level `style_var_prefix` (e.g. style_var_prefix = "--tours")'];
  }

  if (prefix.startsWith('--fm-')) {
    return ['style_var_prefix may not claim the platform --fm- namespace'];
  }

  for (const { owner, surfaces } of declarations) {
    for (const surface of surfaces) {
      for (const slot of surface.slots ?? []) {
        if (slot.var !== prefix && !slot.var.startsWith(`${prefix}-`)) {
          messages.push(
            `${owner}.${surface.key}.${slot.key}: style variable "${slot.var}" is outside this app's namespace "${prefix}" — an app may only declare variables under its own style_var_prefix`,
          );
        }
      }
    }
  }

  return messages;
}

export const ManifestSchema = ManifestInput.superRefine((m, ctx): void => {
  if (!m.slug && !m.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'manifest must declare `slug` (or legacy `id`) — the developer-chosen leaf of <publisher>/<slug>',
      path: ['slug'],
    });
  }

  for (const message of validateSchedules(m.schedules ?? [])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['schedules'] });
  }

  for (const message of validateStyleSurfaces(m)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['style_surfaces'] });
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

/**
 * The effective webhook subscription for a manifest.
 *
 * The `[webhooks]` section is authoritative when present — it is the
 * declarative surface the CLI writes and syncs, and `subscribed_events` is
 * kept only as the legacy/back-compat spelling. `conflict` is true when both
 * are declared with different sets so callers can warn once instead of
 * silently discarding the developer's other list.
 */
export interface ResolvedWebhooks {
  url: string;
  events: string[];
  /** True when legacy `subscribed_events` disagrees with `[webhooks].events`. */
  conflict: boolean;
  /** Which surface won: the declarative section or the legacy top-level key. */
  source: 'webhooks' | 'subscribed_events';
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

/**
 * Resolve the webhook URL + event list the CLI should sync to the platform.
 * Events are de-duplicated and sorted so the payload is stable across runs
 * (a stable payload keeps the host's "did anything change?" checks honest).
 */
export function resolveWebhooks(manifest: AppManifest): ResolvedWebhooks {
  const legacy = [...new Set(manifest.subscribed_events ?? [])].sort();
  const declared = manifest.webhooks?.events;

  if (!declared) {
    return { url: manifest.webhook_url, events: legacy, conflict: false, source: 'subscribed_events' };
  }

  const events = [...new Set(declared)].sort();
  return {
    url: manifest.webhooks?.url ?? manifest.webhook_url,
    events,
    conflict: legacy.length > 0 && !sameSet(legacy, events),
    source: 'webhooks',
  };
}

/** Read and validate the manifest from `dir`. Throws on malformed TOML/schema. */
export async function readManifest(dir: string): Promise<AppManifest> {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No ${MANIFEST_FILENAME} found in ${dir}.\n` +
          'Run this command from your app directory (the one containing ' +
          `${MANIFEST_FILENAME}), or scaffold a new app with \`autohisab-business init my-app\`.`,
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

  const result = ManifestSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  throw new Error(formatManifestIssues(result.error));
}

/**
 * Render a ZodError as the developer-facing manifest report. Zod's default
 * `message` is a JSON dump; a manifest with three bad `[[schedules]]` blocks
 * has to read like three sentences, not like a stack trace.
 */
export function formatManifestIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : MANIFEST_FILENAME;
    return `  • ${where}: ${issue.message}`;
  });
  return `${MANIFEST_FILENAME} is invalid:\n${lines.join('\n')}`;
}

/**
 * A `blueprint_file` failed to read or parse. Always names the file and, for
 * a JSON syntax error, the line/column — the developer is looking at their
 * own file, not the CLI's internals, and "invalid JSON" alone costs them a
 * bisect. Thrown by {@link resolveStorefrontSections}; callers (namely
 * `section dev`) must catch this and refuse to push rather than syncing a
 * shorter section list, which would silently clear the dev install's other
 * sections.
 */
export class SectionBlueprintError extends Error {
  constructor(
    public readonly file: string,
    public readonly detail: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    const where = line !== undefined && column !== undefined ? ` at line ${line}, column ${column}` : '';
    super(`${file}${where}: ${detail}`);
    this.name = 'SectionBlueprintError';
  }
}

/** One `[[storefront_sections]]` entry with `blueprint_file` resolved into `element_tree`. */
export interface ResolvedStorefrontSection {
  type: string;
  name: string;
  source: 'blueprint' | 'static' | 'endpoint';
  category?: string;
  element_tree?: Array<Record<string, unknown>>;
  settings?: EmbedBlockSetting[];
  bindings?: Record<string, unknown>;
  endpoint_path?: string;
  schema_version?: number;
}

/** Compute 1-based line/column for a character offset into `text`. */
function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

/** Extract the character position `JSON.parse` reports in its SyntaxError message, if any. */
function jsonErrorPosition(message: string): number | undefined {
  const match = /position (\d+)/.exec(message);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Resolve every `[[storefront_sections]]` declaration's `blueprint_file` into
 * `element_tree`, reading each file relative to `dir` (the app directory).
 *
 * A section that already declares `element_tree` inline is passed through
 * unchanged even if it also names a `blueprint_file` — the inline value wins,
 * since it is what the developer is looking at in the manifest itself.
 *
 * @throws SectionBlueprintError on a missing file, a file that is not valid
 *   JSON, or JSON that does not parse to an array — naming the file and, for
 *   a syntax error, the line/column.
 */
/**
 * Parse a blueprint file's already-read raw content into an element tree, or
 * throw {@link SectionBlueprintError} with file + line/column context.
 * Factored out of {@link resolveStorefrontSections} so the sync path
 * ({@link resolveStorefrontSectionsSync}, used by `doctor`'s
 * `section-blueprint-valid` rule) shares the exact same JSON-validity and
 * position-reporting logic instead of a second copy that could drift.
 */
function parseBlueprintJson(relFile: string, raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const pos = jsonErrorPosition(msg);
    if (pos !== undefined) {
      const { line, column } = lineColumnAt(raw, pos);
      throw new SectionBlueprintError(relFile, msg, line, column);
    }
    throw new SectionBlueprintError(relFile, msg);
  }

  if (!Array.isArray(parsed)) {
    throw new SectionBlueprintError(relFile, 'must contain a JSON array of element-tree nodes');
  }

  return parsed as Array<Record<string, unknown>>;
}

export async function resolveStorefrontSections(
  dir: string,
  sections: StorefrontSection[],
): Promise<ResolvedStorefrontSection[]> {
  const resolved: ResolvedStorefrontSection[] = [];

  for (const section of sections) {
    let elementTree = section.element_tree;

    if (!elementTree && section.blueprint_file) {
      const relFile = section.blueprint_file;
      const file = path.isAbsolute(relFile) ? relFile : path.join(dir, relFile);
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SectionBlueprintError(relFile, 'file not found');
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new SectionBlueprintError(relFile, msg);
      }

      elementTree = parseBlueprintJson(relFile, raw);
    }

    resolved.push({
      type: section.type,
      name: section.name,
      source: section.source ?? 'blueprint',
      category: section.category,
      element_tree: elementTree,
      settings: section.settings,
      bindings: section.bindings,
      endpoint_path: section.endpoint_path,
      schema_version: section.schema_version,
    });
  }

  return resolved;
}

/**
 * Synchronous counterpart to {@link resolveStorefrontSections}. Every other
 * `doctor` rule (`doctor-rules.ts`) is a synchronous filesystem scan — pulling
 * async into `DoctorRule#check` would ripple into `runDoctor`, `init`'s
 * post-scaffold doctor run, and all 15 existing rule tests, for the sake of
 * one rule. This shares {@link parseBlueprintJson} and the same
 * `SectionBlueprintError` (file/line/column) shape with the async path used
 * by `section dev`, so the two never drift on what counts as a valid
 * blueprint file.
 */
export function resolveStorefrontSectionsSync(
  dir: string,
  sections: StorefrontSection[],
): ResolvedStorefrontSection[] {
  const resolved: ResolvedStorefrontSection[] = [];

  for (const section of sections) {
    let elementTree = section.element_tree;

    if (!elementTree && section.blueprint_file) {
      const relFile = section.blueprint_file;
      const file = path.isAbsolute(relFile) ? relFile : path.join(dir, relFile);
      if (!existsSync(file)) {
        throw new SectionBlueprintError(relFile, 'file not found');
      }
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SectionBlueprintError(relFile, msg);
      }

      elementTree = parseBlueprintJson(relFile, raw);
    }

    resolved.push({
      type: section.type,
      name: section.name,
      source: section.source ?? 'blueprint',
      category: section.category,
      element_tree: elementTree,
      settings: section.settings,
      bindings: section.bindings,
      endpoint_path: section.endpoint_path,
      schema_version: section.schema_version,
    });
  }

  return resolved;
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

/** Render a TOML string array on one line: `["a", "b"]`. */
function tomlArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

/**
 * Rewrite the `[webhooks].events` list IN PLACE, preserving every other line
 * (comments included). Creates the `[webhooks]` table when it does not exist.
 *
 * This is what makes `hooks subscribe` an editor of the manifest rather than a
 * direct API call: the toml is the single source of truth and the next
 * `dev`/`push`/`deploy` syncs it.
 */
export async function writeWebhookEvents(dir: string, events: string[]): Promise<void> {
  const file = path.join(dir, MANIFEST_FILENAME);
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split('\n');
  const rendered = `events = ${tomlArray(events)}`;

  const headerIdx = lines.findIndex((l) => /^\s*\[webhooks\]\s*(#.*)?$/.test(l));
  if (headerIdx === -1) {
    const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? '' : '\n';
    await fs.writeFile(
      file,
      `${raw}${trailing}\n# Declarative webhook subscription. The CLI is the single writer:\n` +
        `# \`autohisab-business hooks subscribe <event>\` edits this list, and\n` +
        `# \`dev\`/\`push\`/\`deploy\` sync it to the platform.\n[webhooks]\n${rendered}\n`,
      'utf8',
    );
    return;
  }

  // Section body ends at the next table header (or EOF).
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }

  const eventsIdx = lines.findIndex(
    (l, i) => i > headerIdx && i < end && /^\s*events\s*=/.test(l),
  );
  if (eventsIdx === -1) {
    lines.splice(headerIdx + 1, 0, rendered);
    await fs.writeFile(file, lines.join('\n'), 'utf8');
    return;
  }

  // The existing value may span several lines; consume until brackets balance.
  let last = eventsIdx;
  let depth = 0;
  for (let i = eventsIdx; i < end; i++) {
    const line = lines[i] ?? '';
    depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    last = i;
    if (depth <= 0) break;
  }

  lines.splice(eventsIdx, last - eventsIdx + 1, rendered);
  await fs.writeFile(file, lines.join('\n'), 'utf8');
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
