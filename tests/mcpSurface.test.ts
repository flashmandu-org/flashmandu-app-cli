import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ManifestSchema } from '../src/services/manifest';
import { resolveMcpSurface, validateMcpTools } from '../src/services/mcpSurface';
import { submitAppForReview } from '../src/services/submissions';
import * as apiClient from '../src/services/apiClient';

/**
 * App MCP declaration (`[mcp]` in flashmandu.app.toml).
 *
 * The host stores `installed_apps.mcp_tools` only through
 * `AppManager::normalizeMcpSurface()` (SDK `McpSurface::fromArray` +
 * `McpSurfaceLimits`), and both `/api/apps/dev/register` and the submission
 * endpoint accept an `mcp: { tools: [...] }` key. The CLI is the single writer:
 * it reads the declaration (inline `[[mcp.tools]]` or a `tools_file` the app's
 * MCP route imports too, so the two can never drift), validates it with the
 * SDK's own rules so a bad declaration fails at `push` time, and sends it.
 */

vi.mock('../src/services/apiClient', () => ({ post: vi.fn(), get: vi.fn(), request: vi.fn() }));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'list_tours',
  description: 'List tours.',
  input_schema: { type: 'object', properties: { status: { type: 'string' } } },
  endpoint: '/mcp',
  scopes: [],
  read_only: true,
  ...over,
});

describe('validateMcpTools (SDK McpTool / McpSurface / McpSurfaceLimits rules)', () => {
  it('accepts a valid surface', () => {
    expect(validateMcpTools([tool(), tool({ name: 'add_scene', scopes: ['read:media'], read_only: false })], ['read:media'])).toEqual([]);
  });

  it.each([
    ['bad name', tool({ name: 'List-Tours' }), /name/],
    ['empty description', tool({ description: '  ' }), /description/],
    ['schema not object', tool({ input_schema: { type: 'array' } }), /type.*object/],
    ['reserved profile_id', tool({ input_schema: { type: 'object', properties: { profile_id: { type: 'integer' } } } }), /profile_id/],
    ['endpoint not a path', tool({ endpoint: 'https://evil/x' }), /endpoint/],
    ['dot segment endpoint', tool({ endpoint: '/mcp/../admin' }), /endpoint/],
    ['scope not requested by the app', tool({ scopes: ['write:orders'] }), /scope/],
    ['description over 1024 chars', tool({ description: 'x'.repeat(1025) }), /1024/],
    ['schema over 16384 bytes', tool({ input_schema: { type: 'object', description: 'x'.repeat(16400) } }), /16384/],
  ])('refuses %s', (_label, bad, pattern) => {
    const errors = validateMcpTools([bad], []);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('refuses duplicate names and more than 50 tools', () => {
    expect(validateMcpTools([tool(), tool()], []).join('\n')).toMatch(/duplicate/i);
    const many = Array.from({ length: 51 }, (_, i) => tool({ name: `t${i}` }));
    expect(validateMcpTools(many, []).join('\n')).toMatch(/50/);
  });
});

describe('resolveMcpSurface', () => {
  const base: any = { slug: 'tours', scopes: ['read:media'] };

  it('is undefined when the app declares no [mcp]', async () => {
    expect(await resolveMcpSurface(base, '/nowhere')).toBeUndefined();
  });

  it('reads tools_file relative to the app dir and returns the host payload shape', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-surface-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'mcp-tools.json'), JSON.stringify({ tools: [tool({ read_only: undefined })] }));
    const surface = await resolveMcpSurface({ ...base, mcp: { tools_file: 'mcp-tools.json' } }, dir);
    expect(surface).toEqual({
      tools: [
        {
          name: 'list_tours',
          description: 'List tours.',
          input_schema: { type: 'object', properties: { status: { type: 'string' } } },
          endpoint: '/mcp',
          scopes: [],
          read_only: true,
        },
      ],
    });
  });

  it('accepts inline [[mcp.tools]]', async () => {
    const surface = await resolveMcpSurface({ ...base, mcp: { tools: [tool()] } }, '/nowhere');
    expect(surface?.tools.map((t) => t.name)).toEqual(['list_tours']);
  });

  it('throws naming the file when tools_file is missing, escapes the app dir, or is invalid', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-surface-'));
    dirs.push(dir);
    await expect(resolveMcpSurface({ ...base, mcp: { tools_file: 'nope.json' } }, dir)).rejects.toThrow(/nope\.json/);
    await expect(resolveMcpSurface({ ...base, mcp: { tools_file: '../x.json' } }, dir)).rejects.toThrow(/inside the app/);
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ tools: [tool({ name: 'Bad' })] }));
    await expect(resolveMcpSurface({ ...base, mcp: { tools_file: 'bad.json' } }, dir)).rejects.toThrow(/bad\.json[\s\S]*name/);
  });
});

describe('manifest + submission wiring', () => {
  it('the manifest schema accepts an [mcp] table', () => {
    const parsed = ManifestSchema.safeParse({
      slug: 'tours',
      name: 'Tours',
      version: '1.0.0',
      authorize_url: 'https://tours.acme.com/oauth/authorize',
      token_url: 'https://tours.acme.com/oauth/token',
      webhook_url: 'https://tours.acme.com/webhooks/flashmandu',
      mcp: { tools_file: 'mcp-tools.json' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mcp).toEqual({ tools_file: 'mcp-tools.json' });
  });

  it('submitAppForReview sends `mcp` when given, and omits it otherwise', async () => {
    const manifest: any = {
      slug: 'tours', name: 'Tours', developer_name: 'A', developer_email: 'a@b.co',
      authorize_url: 'https://tours.acme.com/oauth/authorize', token_url: 'https://tours.acme.com/oauth/token',
      webhook_url: 'https://tours.acme.com/webhooks/flashmandu', scopes: [], subscribed_events: [],
    };
    (apiClient.post as any).mockResolvedValue({ id: 1 });
    const mcp = { tools: [tool()] };
    await submitAppForReview(manifest, { version: '1.0.1', mcp: mcp as any });
    expect((apiClient.post as any).mock.calls.at(-1)[1].mcp).toEqual(mcp);
    await submitAppForReview(manifest, { version: '1.0.2' });
    expect('mcp' in (apiClient.post as any).mock.calls.at(-1)[1]).toBe(false);
  });
});
