import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_FILENAME,
  readManifest,
  resolveWebhooks,
  writeWebhookEvents,
  type AppManifest,
} from '../src/services/manifest';

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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-manifest-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(body: string): Promise<void> {
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), `${BASE}\n${body}\n`, 'utf8');
}

async function read(): Promise<string> {
  return fs.readFile(path.join(dir, MANIFEST_FILENAME), 'utf8');
}

describe('[webhooks] section', () => {
  it('parses events and an optional url', async () => {
    await write('[webhooks]\nurl = "https://hooks.example.com/in"\nevents = ["order.created"]');
    const manifest = await readManifest(dir);

    expect(resolveWebhooks(manifest)).toEqual({
      url: 'https://hooks.example.com/in',
      events: ['order.created'],
      conflict: false,
      source: 'webhooks',
    });
  });

  it('falls back to the top-level webhook_url when the section omits one', async () => {
    await write('[webhooks]\nevents = ["order.created"]');
    expect((await readManifest(dir).then(resolveWebhooks)).url).toBe(
      'https://demo.example.com/webhooks/flashmandu',
    );
  });

  it('de-duplicates and sorts events so the synced payload is stable', async () => {
    await write('[webhooks]\nevents = ["b.event", "a.event", "b.event"]');
    expect((await readManifest(dir).then(resolveWebhooks)).events).toEqual(['a.event', 'b.event']);
  });

  it('lets [webhooks] win over legacy subscribed_events, and flags the conflict', async () => {
    await write('subscribed_events = ["old.event"]\n[webhooks]\nevents = ["new.event"]');
    const resolved = await readManifest(dir).then(resolveWebhooks);

    expect(resolved.events).toEqual(['new.event']);
    expect(resolved.conflict).toBe(true);
  });

  it('does not flag a conflict when both lists agree', async () => {
    await write('subscribed_events = ["same.event"]\n[webhooks]\nevents = ["same.event"]');
    expect((await readManifest(dir).then(resolveWebhooks)).conflict).toBe(false);
  });

  it('uses subscribed_events when no [webhooks] section exists', async () => {
    await write('subscribed_events = ["legacy.event"]');
    const resolved = await readManifest(dir).then(resolveWebhooks);

    expect(resolved.source).toBe('subscribed_events');
    expect(resolved.events).toEqual(['legacy.event']);
  });
});

describe('writeWebhookEvents', () => {
  it('rewrites an existing events list in place, keeping comments', async () => {
    await write('# keep me\n[webhooks]\nevents = ["a.event"]\n# trailing note');
    await writeWebhookEvents(dir, ['a.event', 'b.event']);
    const raw = await read();

    expect(raw).toContain('events = ["a.event", "b.event"]');
    expect(raw).toContain('# keep me');
    expect(raw).toContain('# trailing note');
  });

  it('replaces a multi-line array without leaving orphan lines', async () => {
    await write('[webhooks]\nevents = [\n  "a.event",\n  "b.event",\n]');
    await writeWebhookEvents(dir, ['c.event']);
    const raw = await read();

    expect(raw).toContain('events = ["c.event"]');
    expect(raw).not.toContain('a.event');
    expect(raw).not.toContain('b.event');
    await expect(readManifest(dir)).resolves.toBeTruthy();
  });

  it('creates the section when the manifest has none', async () => {
    await write('');
    await writeWebhookEvents(dir, ['order.created']);

    const manifest: AppManifest = await readManifest(dir);
    expect(manifest.webhooks?.events).toEqual(['order.created']);
  });

  it('adds the key to an existing empty section', async () => {
    await write('[webhooks]');
    await writeWebhookEvents(dir, ['order.created']);

    expect((await readManifest(dir)).webhooks?.events).toEqual(['order.created']);
  });

  it('does not disturb a table that follows [webhooks]', async () => {
    await write('[webhooks]\nevents = ["a.event"]\n\n[[schedules]]\nname = "rollup"\nevery = "15m"');
    await writeWebhookEvents(dir, ['z.event']);

    const manifest = await readManifest(dir);
    expect(manifest.webhooks?.events).toEqual(['z.event']);
    expect(manifest.schedules).toEqual([{ name: 'rollup', every: '15m' }]);
  });
});

describe('schedule validation through the manifest', () => {
  it('reports platform rules as readable lines, not a JSON dump', async () => {
    await write('[[schedules]]\nname = "too-fast"\nevery = "1m"');

    await expect(readManifest(dir)).rejects.toThrow(/minimum of 5 minutes/);
    await expect(readManifest(dir)).rejects.not.toThrow(/"code":/);
  });

  it('accepts a valid schedule set', async () => {
    await write('[[schedules]]\nname = "rollup"\nevery = "15m"\n\n[[schedules]]\nname = "nightly"\ncron = "0 18 * * *"');
    expect((await readManifest(dir)).schedules).toHaveLength(2);
  });
});
