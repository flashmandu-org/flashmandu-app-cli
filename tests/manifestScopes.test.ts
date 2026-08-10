import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANIFEST_FILENAME, readManifest } from '../src/services/manifest';

/**
 * Scope validation.
 *
 * REGRESSION THIS LOCKS DOWN: `SCOPE_RE` was `/^[A-Z][A-Za-z0-9]*$/` — the shape
 * of an enum CASE NAME (`ReadMedia`) rather than its VALUE (`read:media`). The
 * platform only ever speaks values, so `dev`, `push` and `deploy` all failed
 * manifest validation with `scopes.0: Invalid` for any app that declared a real
 * scope. The scaffold template shipped `["ReadOrders"]`, so the template and the
 * regex agreed with each other and both disagreed with the platform, which is
 * why it survived.
 *
 * The list below is the full value set of the host's
 * `Flashmandu\Apps\Ports\PortScope` plus the SDK's `Flashmandu\AppSdk\Scope`,
 * read out of those enums rather than invented here.
 */

const PLATFORM_SCOPES = [
  'read:orders',
  'write:orders',
  'read:customers',
  'write:customers',
  'read:bookings',
  'write:bookings',
  'read:catalog',
  'read:content',
  'read:locations',
  'write:locations',
  'read:settings',
  'read:discounts',
  'read:ledger',
  'write:ledger',
  'read:employees',
  'read:media',
  'send:notifications',
  'broadcast:events',
  'manage:storefront',
  'manage:payments',
];

const BASE = [
  'slug = "demo"',
  'name = "Demo"',
  'version = "0.1.0"',
  'authorize_url = "https://demo.example.com/oauth/authorize"',
  'token_url = "https://demo.example.com/oauth/token"',
  'webhook_url = "https://demo.example.com/webhooks/flashmandu"',
].join('\n');

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-scopes-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(body: string): Promise<void> {
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), `${BASE}\n${body}\n`, 'utf8');
}

describe('scope validation', () => {
  it('accepts every scope the platform defines', async () => {
    await write(`scopes = ${JSON.stringify(PLATFORM_SCOPES)}`);

    const manifest = await readManifest(dir);

    expect(manifest.scopes).toEqual(PLATFORM_SCOPES);
  });

  it('accepts read:media — the exact value that used to be rejected', async () => {
    await write('scopes = ["read:media"]');

    await expect(readManifest(dir)).resolves.toMatchObject({ scopes: ['read:media'] });
  });

  it('rejects an enum CASE NAME, which is what the old pattern demanded', async () => {
    await write('scopes = ["ReadMedia"]');

    await expect(readManifest(dir)).rejects.toThrow(/scopes/);
  });

  it.each([
    ['no colon', 'readmedia'],
    ['empty resource', 'read:'],
    ['empty verb', ':media'],
    ['uppercase', 'READ:MEDIA'],
    ['a third segment', 'read:media:extra'],
    ['a leading hyphen in the resource', 'read:-media'],
    ['a trailing hyphen in the resource', 'read:media-'],
    ['whitespace', 'read: media'],
  ])('rejects %s', async (_label, value) => {
    await write(`scopes = ${JSON.stringify([value])}`);

    await expect(readManifest(dir)).rejects.toThrow(/scopes/);
  });

  it('tolerates a multi-word resource the catalog has not shipped yet', async () => {
    // Forward-tolerance, not a real scope: the host owns the catalog and
    // validates membership at register time. The CLI only checks the shape, so
    // a new scope does not need a CLI release.
    await write('scopes = ["read:price-lists"]');

    await expect(readManifest(dir)).resolves.toMatchObject({ scopes: ['read:price-lists'] });
  });

  it('applies the same rule to embed-block scopes', async () => {
    await write(
      [
        '[[embed_blocks]]',
        'type = "demo"',
        'name = "Demo"',
        'block_path = "/embed/demo"',
        'scopes = ["ReadOrders"]',
      ].join('\n'),
    );

    await expect(readManifest(dir)).rejects.toThrow(/scopes/);
  });
});
