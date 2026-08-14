import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as TOML from '@iarna/toml';
import { ManifestSchema, type AppManifest } from '../src/services/manifest';
import { buildExtensionPayload, type WireExtension } from '../src/services/extensions';
import { scaffoldApp } from '../src/commands/init';

/**
 * The CLI is the only producer of `installed_apps.extensions`, and the host's
 * `ExtensionManifestReader` is its only consumer. These tests pin the contract
 * between them from the CLI side; the host side is pinned by
 * `packages/flashmandu/apps/tests/Feature/Extensions/CliManifestPayloadTest.php`,
 * which feeds the SAME fixtures through the real reader. Both halves have to be
 * edited together — that is the point.
 *
 * The reader discriminates payloads in a fixed order:
 *
 *   `targeting` present   → fromUnifiedPayload()
 *   block_origin + block_path → fromEmbedBlockPayload()
 *   bare `target`         → fromLegacyExtensionPayload()
 *
 * so everything emitted here carries `targeting` and is read as unified. A
 * desugared embed block ALSO keeps its `type`/`block_path` keys, which the
 * unified branch ignores and an older host still hydrates from.
 */

const ORIGIN = 'https://tunnel.example.test';

function parse(toml: string): AppManifest {
  return ManifestSchema.parse(TOML.parse(toml));
}

function payloadFor(toml: string): WireExtension[] {
  return buildExtensionPayload(parse(toml), ORIGIN);
}

const BASE = `
slug = "demo"
name = "Demo"
version = "0.1.0"
authorize_url = "https://app.test/oauth/authorize"
token_url = "https://app.test/oauth/token"
webhook_url = "https://app.test/webhooks/flashmandu"
`;

describe('the unified [[extensions]] shape', () => {
  it('parses one extension with several targeting blocks', () => {
    const manifest = parse(`${BASE}
[[extensions]]
handle       = "loyalty"
name         = "Loyalty"
api_version  = "2026-08"
capabilities = ["identity", "resize", "toast"]
scopes       = ["read:orders"]
port_scopes  = ["read:ledger"]

  [[extensions.targeting]]
  target = "admin.order.detail.block"
  mode   = "iframe"
  path   = "/embed/order"

  [[extensions.targeting]]
  target = "pos.cart.action"
  mode   = "iframe"
  path   = "/embed/cart"
`);

    expect(manifest.extensions).toHaveLength(1);
    expect((manifest.extensions?.[0] as { targeting: unknown[] }).targeting).toHaveLength(2);
  });

  it('emits the payload shape fromUnifiedPayload() reads', () => {
    const [wire] = payloadFor(`${BASE}
[[extensions]]
handle       = "loyalty"
name         = "Loyalty"
api_version  = "2026-08"
capabilities = ["toast"]
scopes       = ["read:orders"]
port_scopes  = ["read:ledger"]

  [[extensions.targeting]]
  target = "admin.order.detail.block"
  mode   = "iframe"
  path   = "/embed/order"
`);

    expect(wire.handle).toBe('loyalty');
    expect(wire.api_version).toBe('2026-08');
    expect(wire.targeting).toEqual([
      {
        target: 'admin.order.detail.block',
        mode: 'iframe',
        path: '/embed/order',
        should_render: undefined,
        block: undefined,
        remote_url: undefined,
      },
    ]);
    // Nested, not flat: it is the only form that can carry port scopes, and the
    // host reads `scopes.required` before it falls back to a bare list.
    expect(wire.scopes).toEqual({ required: ['read:orders'], required_port: ['read:ledger'] });
    expect(wire.block_origin).toBe(ORIGIN);
    expect(wire.hosting_tier).toBe('remote');
  });

  it('infers mode the way the host does — block wins over a URL', () => {
    const [wire] = payloadFor(`${BASE}
[[extensions]]
handle = "first-party"

  [[extensions.targeting]]
  target = "admin.item.detail.block"
  block  = "Acme\\\\Blocks\\\\ItemPanel"
`);

    expect(wire.targeting[0]?.mode).toBe('block');
  });

  it('defaults an undeclared mode to iframe', () => {
    const [wire] = payloadFor(`${BASE}
[[extensions]]
handle = "framed"

  [[extensions.targeting]]
  target = "admin.item.detail.block"
  path   = "/embed/item"
`);

    expect(wire.targeting[0]?.mode).toBe('iframe');
  });

  it('rejects an extension with no targeting block', () => {
    expect(() =>
      parse(`${BASE}
[[extensions]]
handle = "nowhere"
`),
    ).toThrow();
  });

  it('rejects a target that is not dotted', () => {
    expect(() =>
      parse(`${BASE}
[[extensions]]
handle = "bad"

  [[extensions.targeting]]
  target = "adminorderdetailblock"
`),
    ).toThrow();
  });
});

describe('the legacy flat [[extensions]] form', () => {
  const FLAT = `${BASE}
[[extensions]]
target             = "admin.order.detail.block"
label              = "Old panel"
remoteUrl          = "https://app.test/panel"
requiredScopes     = ["read:orders"]
requiredPortScopes = ["read:ledger"]
`;

  it('still parses', () => {
    expect(parse(FLAT).extensions).toHaveLength(1);
  });

  it('desugars into one targeting block without breaking', () => {
    const [wire] = payloadFor(FLAT);

    expect(wire.targeting).toHaveLength(1);
    expect(wire.targeting[0]?.target).toBe('admin.order.detail.block');
    expect(wire.targeting[0]?.remote_url).toBe('https://app.test/panel');
    expect(wire.name).toBe('Old panel');
    expect(wire.scopes).toEqual({ required: ['read:orders'], required_port: ['read:ledger'] });
  });

  it('derives the handle exactly as the host does, so a placement toggle survives the upgrade', () => {
    // fromLegacyExtensionPayload(): dots to dashes. If the CLI derived it any
    // other way, a merchant who had disabled this extension would find it
    // silently back on after the app republished.
    expect(payloadFor(FLAT)[0]?.handle).toBe('admin-order-detail-block');
  });

  it('honours an explicit handle when the developer supplies one', () => {
    const [wire] = payloadFor(`${BASE}
[[extensions]]
target = "admin.order.detail.block"
handle = "chosen"
`);

    expect(wire.handle).toBe('chosen');
  });
});

describe('[[embed_blocks]] desugaring', () => {
  const BLOCKS = `${BASE}
[[embed_blocks]]
type       = "promo-band"
name       = "Promo band"
block_path = "/blocks/promo"
capabilities = ["identity", "resize"]

  [[embed_blocks.settings]]
  name  = "headline"
  label = "Headline"
  type  = "text"
  dynamic_options_source = "app"
  dynamic_options_path   = "/options/headlines"
`;

  it('becomes a storefront.section iframe binding', () => {
    const [wire] = payloadFor(BLOCKS);

    expect(wire.handle).toBe('promo-band');
    expect(wire.targeting).toHaveLength(1);
    expect(wire.targeting[0]?.target).toBe('storefront.section');
    expect(wire.targeting[0]?.mode).toBe('iframe');
    expect(wire.targeting[0]?.path).toBe('/blocks/promo');
    expect(wire.block_origin).toBe(ORIGIN);
  });

  it('keeps the legacy embed-block keys so a host without the unified reader still hydrates it', () => {
    const [wire] = payloadFor(BLOCKS);

    expect(wire.type).toBe('promo-band');
    expect(wire.block_path).toBe('/blocks/promo');
  });

  it('normalizes dynamic_options_* into the canonical {source, path} object', () => {
    const [wire] = payloadFor(BLOCKS);
    const setting = (wire.settings as Array<Record<string, unknown>>)[0];

    expect(setting?.dynamic_options).toEqual({ source: 'app', path: '/options/headlines' });
  });

  it('emits extensions before embed blocks, so a half-migrated app sees a duplicate rather than a silent replacement', () => {
    const payload = payloadFor(`${BLOCKS}
[[extensions]]
handle = "promo-band-v2"

  [[extensions.targeting]]
  target = "storefront.section"
  path   = "/blocks/promo-v2"
`);

    expect(payload.map((p) => p.handle)).toEqual(['promo-band-v2', 'promo-band']);
  });
});

describe('the scaffold', () => {
  it('is born declaring the unified shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-scaffold-'));

    await scaffoldApp(dir, { template: 'next-js', appSlug: 'demo-app', name: 'Demo App' });

    const raw = await fs.readFile(path.join(dir, 'flashmandu.app.toml'), 'utf8');
    const manifest = parse(raw);

    expect(manifest.extensions).toHaveLength(1);

    const [wire] = buildExtensionPayload(manifest, ORIGIN);
    expect(wire.handle).toBe('hello-block');
    expect(wire.targeting[0]?.target).toBe('storefront.section');
    expect(wire.targeting[0]?.mode).toBe('iframe');

    // The scaffolded path must be a route the template actually serves, or the
    // first thing a new app does is 404 inside a merchant's storefront.
    expect(wire.targeting[0]?.path).toBe('/embed/hello');
    await expect(
      fs.stat(path.join(dir, 'app', 'embed', '[type]', 'page.tsx')),
    ).resolves.toBeTruthy();

    await fs.rm(dir, { recursive: true, force: true });
  });
});

/**
 * Style Surfaces (design §3.1). `style_var_prefix` / `style_schema_version` are
 * APP-level manifest keys, but the host reads them back off each BLOCK payload
 * — `installed_apps.extensions` is the only channel that survives. The CLI is
 * what flattens them, so these tests are that contract from this side; the host
 * half is `StyleSurfaceSchema::fromEmbedBlockPayload()`.
 */
describe('style surfaces', () => {
  const STYLED = `${BASE}
style_var_prefix     = "--tours"
style_schema_version = 1

[[embed_blocks]]
type       = "virtual-tour"
name       = "Virtual Tour"
block_path = "/embed/virtual-tour"

  [[embed_blocks.style_surfaces]]
  key  = "pin_card"
  name = "Info card"

    [[embed_blocks.style_surfaces.slots]]
    key     = "radius"
    label   = "Corner radius"
    type    = "length"
    var     = "--tours-card-radius"
    default = "12px"
    units   = ["px", "rem"]
    min     = 0
    max     = 48
`;

  it('flattens the app-level namespace keys onto every declaring block', () => {
    const [block] = payloadFor(STYLED);

    expect(block.style_var_prefix).toBe('--tours');
    expect(block.style_schema_version).toBe(1);
    expect(block.style_surfaces).toHaveLength(1);
  });

  it('keeps per-slot constraint keys the CLI does not model', () => {
    const [block] = payloadFor(STYLED);
    const slot = (block.style_surfaces as Array<{ slots: Array<Record<string, unknown>> }>)[0].slots[0];

    expect(slot.units).toEqual(['px', 'rem']);
    expect(slot.min).toBe(0);
    expect(slot.max).toBe(48);
  });

  it('defaults the schema version when only a prefix is declared', () => {
    const [block] = payloadFor(STYLED.replace('style_schema_version = 1\n', ''));

    expect(block.style_schema_version).toBe(1);
  });

  it('adds no style keys at all to a block that declares no surfaces', () => {
    const [block] = payloadFor(`${BASE}
style_var_prefix = "--tours"

[[embed_blocks]]
type       = "plain"
name       = "Plain"
block_path = "/embed/plain"
`);

    expect(block).not.toHaveProperty('style_var_prefix');
    expect(block).not.toHaveProperty('style_schema_version');
    expect(block.style_surfaces).toBeUndefined();
  });

  it('refuses surfaces declared without an app-level prefix', () => {
    expect(() => parse(STYLED.replace('style_var_prefix     = "--tours"\n', ''))).toThrow(
      /must also declare app-level `style_var_prefix`/,
    );
  });

  it('refuses a slot var outside the app namespace', () => {
    expect(() => parse(STYLED.replace('"--tours-card-radius"', '"--fm-primary"'))).toThrow(
      /outside this app's namespace/,
    );
  });

  it('refuses an app claiming the platform --fm- namespace', () => {
    expect(() => parse(STYLED.replace('"--tours"', '"--fm-tours"').replace('--tours-card-radius', '--fm-tours-card-radius'))).toThrow(
      /may not claim the platform --fm- namespace/,
    );
  });
});
