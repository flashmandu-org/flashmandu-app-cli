import type {
  AnyManifestExtension,
  AppManifest,
  EmbedBlock,
  EmbedBlockSetting,
  ExtensionTargeting,
  FlatManifestExtension,
  ManifestExtension,
} from './manifest';

/**
 * The one place a manifest's UI declarations become the payload the platform
 * persists on `installed_apps.extensions`.
 *
 * ## Why this exists
 *
 * The host has ONE reader — `Flashmandu\Apps\Extensions\ExtensionManifestReader`
 * — with four constructors, and it is authoritative:
 *
 *  1. `fromUnifiedPayload()`       — the payload carries a `targeting` list
 *  2. `fromEmbedBlockPayload()`    — the payload carries `block_origin` + `block_path`
 *  3. `fromLegacyExtensionPayload()` — the payload carries a bare `target`
 *  4. the manifest-object wrappers — for first-party in-process apps only
 *
 * The reader discriminates in exactly that order, so a payload carrying
 * `targeting` is read as unified no matter what else is on it. Until this
 * module existed the CLI could only emit shape 2, which meant a partner could
 * not author a unified extension at all: the shape the host had learned to read
 * had no producer.
 *
 * ## What is emitted
 *
 * Always shape 1. Both authoring forms desugar into it:
 *
 *  - `[[extensions]]` with `targeting` → straight through;
 *  - `[[extensions]]` flat (`target` at the top level) → one targeting block;
 *  - `[[embed_blocks]]` → one `storefront.section` targeting block, mode
 *    `iframe`, path = `block_path`.
 *
 * ## The deliberate belt-and-braces on embed blocks
 *
 * A desugared embed block ALSO keeps its `type` / `block_path` / `block_origin`
 * keys. It costs three JSON keys and it buys two things: a host that predates
 * the unified reader still hydrates the block through the old embed-block path,
 * and a host that has it reads the `targeting` list first and never looks at
 * them. Emitting only the unified keys would have made a CLI upgrade a silent
 * storefront outage on any instance that had not deployed the reader yet.
 *
 * ## Origin
 *
 * `block_origin` is injected here, not authored: a manifest declares a PATH,
 * and the origin is whatever the app is reachable at right now (the tunnel URL
 * under `dev`, the deployed host later). Pinning it in the toml would make
 * every manifest wrong the moment the tunnel rotated.
 */

/** The wire shape of one `targeting` block, as the host's reader spells it. */
interface WireTargeting {
  target: string;
  mode: 'block' | 'iframe' | 'render-spec';
  path?: string;
  should_render?: string;
  block?: string;
  remote_url?: string;
}

/** The unified payload, as `fromUnifiedPayload()` reads it. */
export interface WireExtension {
  handle: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  api_version?: string;
  targeting: WireTargeting[];
  capabilities: string[];
  scopes: { required: string[]; required_port: string[] };
  settings: unknown[];
  schema_version: number;
  replaces?: string;
  hosting_tier: string;
  block_origin: string;
  /** Embed-block compatibility keys. Present only on a desugared block. */
  type?: string;
  block_path?: string;
  /**
   * Style Surfaces. `style_surfaces` is authored per block/extension, but
   * `style_var_prefix` / `style_schema_version` are APP-level manifest keys —
   * they are FLATTENED onto every declaring entry here because
   * `installed_apps.extensions` is the only channel that survives to the host,
   * and `StyleSurfaceSchema::fromEmbedBlockPayload()` reads all three off the
   * one block payload. Absent entirely on an entry that declares no surfaces,
   * so a manifest without Style Surfaces produces a byte-identical payload.
   */
  style_surfaces?: unknown[];
  style_var_prefix?: string;
  style_schema_version?: number;
}

/** True when the developer authored the unified form. */
function isUnified(entry: AnyManifestExtension): entry is ManifestExtension {
  return Array.isArray((entry as ManifestExtension).targeting);
}

/**
 * Normalize one setting, folding the flat `dynamic_options_*` pair into the
 * `{source, path}` object `EmbedBlockCatalog` and the settings inspector read.
 * Both spellings are accepted host-side, but the persisted row should carry the
 * canonical one so a fresh install resolves without a data patch.
 */
function wireSetting(s: EmbedBlockSetting): Record<string, unknown> {
  return {
    name: s.name,
    label: s.label,
    type: s.type,
    required: s.required,
    help: s.help,
    default: s.default,
    options: s.options,
    dynamic_options:
      s.dynamic_options_source || s.dynamic_options_path
        ? {
            source: s.dynamic_options_source ?? 'app',
            path: s.dynamic_options_path ?? '',
          }
        : undefined,
  };
}

/**
 * Infer the render mode when the developer did not declare one, using the SAME
 * precedence as the host's `ExtensionMode::infer()` — `block` wins over a URL,
 * because that is the order the host's slot template dispatches in. Inferring
 * differently here would mean a manifest resolves one way in the CLI's own
 * output and another way at render.
 */
function resolveMode(t: ExtensionTargeting): 'block' | 'iframe' | 'render-spec' {
  if (t.mode) return t.mode;
  if (t.block && t.block !== '') return 'block';
  return 'iframe';
}

function wireTargeting(t: ExtensionTargeting): WireTargeting {
  return {
    target: t.target,
    mode: resolveMode(t),
    path: t.path,
    should_render: t.should_render,
    block: t.block,
    remote_url: t.remote_url,
  };
}

/** Desugar the flat `[[extensions]]` form into the unified one. */
export function desugarFlatExtension(entry: FlatManifestExtension): ManifestExtension {
  return {
    // The flat shape has never carried a handle. The host derives one from the
    // target (dots to dashes) when it is missing; deriving it identically HERE
    // means the placement row keeps the same key whether the payload was
    // desugared by the CLI or by the host, so a merchant's toggle survives a
    // CLI upgrade instead of silently resetting to the surface default.
    handle: entry.handle ?? entry.target.replace(/\./g, '-'),
    name: entry.label,
    icon: entry.icon,
    api_version: entry.api_version,
    targeting: [
      {
        target: entry.target,
        mode: entry.mode,
        path: entry.path,
        should_render: entry.should_render,
        block: entry.block,
        remote_url: entry.remote_url ?? entry.remoteUrl,
      },
    ],
    capabilities: entry.capabilities ?? [],
    scopes: entry.scopes ?? entry.requiredScopes ?? [],
    port_scopes: entry.port_scopes ?? entry.requiredPortScopes ?? [],
    settings: entry.settings ?? [],
  };
}

/** Desugar one `[[embed_blocks]]` entry into the unified one. */
export function desugarEmbedBlock(block: EmbedBlock): ManifestExtension {
  return {
    // The host's own embed-block desugaring uses `type` as the handle. Matching
    // it keeps `installed_app_extensions.extension_handle` stable for blocks
    // that were placed before the CLI started emitting the unified shape.
    handle: block.type,
    name: block.name,
    description: block.description,
    category: block.category,
    icon: block.icon,
    targeting: [
      { target: 'storefront.section', mode: 'iframe', path: block.block_path },
    ],
    capabilities: block.capabilities ?? [],
    scopes: block.scopes ?? [],
    schema_version: block.schema_version ?? 1,
    hosting_tier: block.hosting_tier ?? 'remote',
    settings: block.settings ?? [],
    style_surfaces: block.style_surfaces,
  };
}

function toWire(e: ManifestExtension, origin: string, embedBlockOf?: EmbedBlock): WireExtension {
  const wire: WireExtension = {
    handle: e.handle,
    // The host falls back to the handle for an empty name, and the management
    // screen must always have something to print.
    name: e.name && e.name !== '' ? e.name : e.handle,
    description: e.description,
    category: e.category,
    icon: e.icon,
    api_version: e.api_version,
    targeting: e.targeting.map(wireTargeting),
    capabilities: e.capabilities ?? [],
    // Nested rather than flat: `fromUnifiedPayload()` reads
    // `scopes.required` / `scopes.required_port` first and only then falls back
    // to a bare list, and the nested form is the only one that can carry port
    // scopes at all.
    scopes: {
      required: e.scopes ?? [],
      required_port: e.port_scopes ?? [],
    },
    settings: (e.settings ?? []).map(wireSetting),
    schema_version: e.schema_version ?? 1,
    replaces: e.replaces,
    hosting_tier: e.hosting_tier ?? 'remote',
    block_origin: origin,
  };

  if (embedBlockOf) {
    wire.type = embedBlockOf.type;
    wire.block_path = embedBlockOf.block_path;
  }

  if (e.style_surfaces && e.style_surfaces.length > 0) {
    wire.style_surfaces = e.style_surfaces;
  }

  return wire;
}

/**
 * Every UI declaration in the manifest, as the unified payload the platform
 * persists. `origin` is the app's currently reachable https origin.
 *
 * `[[extensions]]` comes first and `[[embed_blocks]]` after, so an app that
 * migrates a block to `[[extensions]]` and leaves the old table behind gets a
 * duplicate rather than a silent replacement — the duplicate is visible in the
 * extension console, a silent replacement would not be.
 */
export function buildExtensionPayload(manifest: AppManifest, origin: string): WireExtension[] {
  const payload: WireExtension[] = [];

  for (const entry of manifest.extensions ?? []) {
    payload.push(toWire(isUnified(entry) ? entry : desugarFlatExtension(entry), origin));
  }

  for (const block of manifest.embed_blocks ?? []) {
    payload.push(toWire(desugarEmbedBlock(block), origin, block));
  }

  return payload.map((wire) => flattenStyleNamespace(wire, manifest));
}

/**
 * Copy the APP-level `style_var_prefix` / `style_schema_version` onto every
 * entry that actually declares style surfaces.
 *
 * This is the CLI's half of a contract documented on the host side
 * (`StyleSurfaceSchema`): those two keys are app-level facts with no app-level
 * column to live in, so the host reads them back off each BLOCK payload. An
 * entry that declares no surfaces is returned UNTOUCHED — no new keys, no
 * payload churn for the apps that will never use this.
 */
function flattenStyleNamespace(wire: WireExtension, manifest: AppManifest): WireExtension {
  if (!wire.style_surfaces || wire.style_surfaces.length === 0) {
    return wire;
  }

  return {
    ...wire,
    style_var_prefix: manifest.style_var_prefix,
    style_schema_version: manifest.style_schema_version ?? 1,
  };
}
