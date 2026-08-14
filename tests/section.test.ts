import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as TOML from '@iarna/toml';

import { ApiError } from '../src/services/apiClient';
import {
  ManifestSchema,
  resolveStorefrontSections,
  SectionBlueprintError,
  type AppManifest,
} from '../src/services/manifest';
import {
  pushOnce,
  runAndReport,
  SectionPushRejected,
  toWireSection,
  watchSections,
  type SectionDevEvent,
  type SectionsPushResult,
} from '../src/services/sectionDev';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'section-test-'));
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

const BASE = `
slug = "demo"
name = "Demo"
version = "0.1.0"
authorize_url = "https://app.test/oauth/authorize"
token_url = "https://app.test/oauth/token"
webhook_url = "https://app.test/webhooks/flashmandu"
`;

function parseManifest(toml: string): AppManifest {
  return ManifestSchema.parse(TOML.parse(toml));
}

/** Wait until `predicate()` is true or `timeoutMs` elapses; polls every 10ms. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('resolveStorefrontSections — blueprint_file inlining', () => {
  it('inlines a blueprint_file into element_tree', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'sections/events-calendar.json',
      JSON.stringify([{ type: 'heading', text: 'Events' }]),
    );
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "events-calendar"
name = "Events Calendar"
source = "blueprint"
blueprint_file = "sections/events-calendar.json"
`);

    const resolved = await resolveStorefrontSections(dir, manifest.storefront_sections ?? []);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      type: 'events-calendar',
      name: 'Events Calendar',
      source: 'blueprint',
      element_tree: [{ type: 'heading', text: 'Events' }],
    });
  });

  it('leaves an inline element_tree untouched even without a blueprint_file', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "inline-section"
name = "Inline"
source = "blueprint"
element_tree = [{ type = "text", text = "hi" }]
`);

    const resolved = await resolveStorefrontSections(dir, manifest.storefront_sections ?? []);
    expect(resolved[0]?.element_tree).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('pushes an endpoint-source section correctly with no blueprint file', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "live-feed"
name = "Live Feed"
source = "endpoint"
endpoint_path = "/sections/live-feed"
`);

    const resolved = await resolveStorefrontSections(dir, manifest.storefront_sections ?? []);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      type: 'live-feed',
      source: 'endpoint',
      endpoint_path: '/sections/live-feed',
    });
    expect(resolved[0]?.element_tree).toBeUndefined();

    const wire = toWireSection(resolved[0]!);
    expect(wire).toEqual({
      type: 'live-feed',
      name: 'Live Feed',
      source: 'endpoint',
      endpoint_path: '/sections/live-feed',
    });
  });

  it('reports file + position on malformed local JSON and does not resolve', async () => {
    const dir = await tempDir();
    await write(dir, 'sections/broken.json', '[{ "type": "heading", }]');
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "broken"
name = "Broken"
source = "blueprint"
blueprint_file = "sections/broken.json"
`);

    await expect(resolveStorefrontSections(dir, manifest.storefront_sections ?? [])).rejects.toThrow(
      SectionBlueprintError,
    );

    try {
      await resolveStorefrontSections(dir, manifest.storefront_sections ?? []);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SectionBlueprintError);
      const e = err as SectionBlueprintError;
      expect(e.file).toBe('sections/broken.json');
      expect(e.message).toContain('sections/broken.json');
      // JSON.parse reports a position for this specific malformed input; the
      // resolver must have translated it into a line/column.
      expect(e.line).toBeGreaterThan(0);
      expect(e.column).toBeGreaterThan(0);
    }
  });

  it('reports a missing blueprint_file by name', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "missing"
name = "Missing"
source = "blueprint"
blueprint_file = "sections/does-not-exist.json"
`);

    await expect(resolveStorefrontSections(dir, manifest.storefront_sections ?? [])).rejects.toMatchObject({
      file: 'sections/does-not-exist.json',
    });
  });

  it('reports a blueprint file whose JSON is not an array', async () => {
    const dir = await tempDir();
    await write(dir, 'sections/object.json', JSON.stringify({ type: 'heading' }));
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "not-array"
name = "Not Array"
source = "blueprint"
blueprint_file = "sections/object.json"
`);

    await expect(resolveStorefrontSections(dir, manifest.storefront_sections ?? [])).rejects.toThrow(
      /JSON array/,
    );
  });
});

describe('pushOnce — malformed JSON must not push', () => {
  it('does not call the pusher when a blueprint_file is malformed', async () => {
    const dir = await tempDir();
    await write(dir, 'sections/broken.json', 'not json at all');
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "broken"
name = "Broken"
source = "blueprint"
blueprint_file = "sections/broken.json"
`);

    const pusher = vi.fn(async (): Promise<SectionsPushResult> => ({ synced: 0, types: [] }));

    await expect(pushOnce(dir, { manifest, pusher })).rejects.toThrow(SectionBlueprintError);
    expect(pusher).not.toHaveBeenCalled();
  });
});

describe('pushOnce — 422 rejection surfaces the node-path message verbatim', () => {
  it('wraps an ApiError 422 into SectionPushRejected carrying the exact server message', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "events-calendar"
name = "Events Calendar"
source = "blueprint"
element_tree = [{ type = "script" }]
`);

    const serverMessage = "sections[0].children[2]: unknown node type 'script'";
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => {
      throw new ApiError(422, 'https://dev.test/api/apps/dev/sections', 'Unprocessable', {
        message: serverMessage,
        errors: { sections: [serverMessage] },
      });
    });

    try {
      await pushOnce(dir, { manifest, pusher });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SectionPushRejected);
      expect((err as SectionPushRejected).serverMessage).toBe(serverMessage);
    }
  });

  it('propagates a non-422 ApiError unchanged', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "x"
name = "X"
source = "blueprint"
element_tree = [{ type = "heading" }]
`);
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => {
      throw new ApiError(500, 'https://dev.test/api/apps/dev/sections', 'boom');
    });

    await expect(pushOnce(dir, { manifest, pusher })).rejects.toMatchObject({ status: 500 });
  });
});

describe('runAndReport', () => {
  it('reports a blueprint-error event and never invokes the pusher', async () => {
    const dir = await tempDir();
    await write(dir, 'sections/broken.json', '{not valid');
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "broken"
name = "Broken"
source = "blueprint"
blueprint_file = "sections/broken.json"
`);
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => ({ synced: 1, types: ['broken'] }));
    const events: SectionDevEvent[] = [];

    await runAndReport(dir, { manifest, pusher }, (e) => events.push(e));

    expect(pusher).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('blueprint-error');
    expect(events[0]?.message).toContain('sections/broken.json');
  });

  it('reports a rejected event with the verbatim server message', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "x"
name = "X"
source = "blueprint"
element_tree = [{ type = "script" }]
`);
    const serverMessage = "sections[0].children[0]: unknown node type 'script'";
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => {
      throw new ApiError(422, 'https://dev.test/api/apps/dev/sections', 'Unprocessable', {
        message: serverMessage,
      });
    });
    const events: SectionDevEvent[] = [];

    await runAndReport(dir, { manifest, pusher }, (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'rejected', message: serverMessage });
  });

  it('reports a pushed event with the synced summary on success', async () => {
    const dir = await tempDir();
    const manifest = parseManifest(`${BASE}
[[storefront_sections]]
type = "events-calendar"
name = "Events Calendar"
source = "blueprint"
element_tree = [{ type = "heading" }]
`);
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => ({
      synced: 1,
      types: ['events-calendar'],
    }));
    const events: SectionDevEvent[] = [];

    await runAndReport(dir, { manifest, pusher }, (e) => events.push(e));

    expect(pusher).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'pushed' });
    expect(events[0]?.result).toEqual({ synced: 1, types: ['events-calendar'] });
  });
});

describe('watchSections', () => {
  it('invokes the injected pusher on the initial run and again on a blueprint_file change', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'sections/events-calendar.json',
      JSON.stringify([{ type: 'heading', text: 'v1' }]),
    );
    await write(
      dir,
      'flashmandu.app.toml',
      `${BASE}
[[storefront_sections]]
type = "events-calendar"
name = "Events Calendar"
source = "blueprint"
blueprint_file = "sections/events-calendar.json"
`,
    );

    const calls: Array<Array<Record<string, unknown>>> = [];
    const pusher = vi.fn(async (sections: Array<Record<string, unknown>>): Promise<SectionsPushResult> => {
      calls.push(sections);
      return { synced: sections.length, types: sections.map((s) => String(s.type)) };
    });
    const events: SectionDevEvent[] = [];

    const handle = watchSections(dir, { pusher, debounceMs: 20 }, (e) => events.push(e));

    try {
      await waitFor(() => calls.length >= 1);
      expect(calls[0]?.[0]).toMatchObject({ element_tree: [{ type: 'heading', text: 'v1' }] });

      await write(
        dir,
        'sections/events-calendar.json',
        JSON.stringify([{ type: 'heading', text: 'v2' }]),
      );

      await waitFor(() => calls.length >= 2, 5000);
      const last = calls[calls.length - 1];
      expect(last?.[0]).toMatchObject({ element_tree: [{ type: 'heading', text: 'v2' }] });
      expect(events.some((e) => e.type === 'pushed')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('does not push again after close()', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      `${BASE}
[[storefront_sections]]
type = "x"
name = "X"
source = "blueprint"
element_tree = [{ type = "heading" }]
`,
    );
    const pusher = vi.fn(async (): Promise<SectionsPushResult> => ({ synced: 1, types: ['x'] }));
    const handle = watchSections(dir, { pusher, debounceMs: 20 }, () => {});

    await waitFor(() => pusher.mock.calls.length >= 1);
    handle.close();
    const callsAtClose = pusher.mock.calls.length;

    await write(
      dir,
      'flashmandu.app.toml',
      `${BASE}
[[storefront_sections]]
type = "x"
name = "X"
source = "blueprint"
element_tree = [{ type = "text" }]
`,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(pusher.mock.calls.length).toBe(callsAtClose);
  });
});
