import { describe, expect, it, vi } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The starter's signed MCP endpoint factory (`src/templates/next-js/lib/mcp.ts`).
 *
 * Host contract (packages/flashmandu/apps: AppMcpTool + AppMcpTransport):
 * one POST per call, body `{tool, arguments, profile_id, request_id}`, signed
 * with WebhookSigner (`X-App-Signature = hex(hmac_sha256("{ts}.{raw}",
 * webhook_secret))`, `X-App-Event: mcp.tool_call`, `X-App-Delivery` =
 * request id). The app must: verify the signature over the RAW body, act only
 * for the signed top-level `profile_id` (never an `arguments.profile_id`),
 * dispatch only DECLARED tools, and never echo handler internals.
 *
 * `@flashmandu/app-bridge/server` is not a CLI dependency, so its
 * `verifyWebhook` is mocked here with the same algorithm; the scaffolded app
 * (and Tours' tests) run the real one.
 */

const SECRET = 'whsec_test';

vi.mock('@flashmandu/app-bridge/server', () => ({
  verifyWebhook: ({ rawBody, headers, secret, maxSkewSeconds = 300 }: {
    rawBody: string; headers: Headers; secret: string; maxSkewSeconds?: number;
  }) => {
    const sig = headers.get('x-app-signature');
    const ts = headers.get('x-app-timestamp');
    if (!sig || !ts) return { ok: false, reason: 'missing signature headers' };
    if (Math.abs(Date.now() / 1000 - Number(ts)) > maxSkewSeconds) return { ok: false, reason: 'timestamp outside tolerance' };
    const want = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    return ok
      ? { ok: true, event: headers.get('x-app-event') ?? undefined, deliveryId: headers.get('x-app-delivery') ?? undefined }
      : { ok: false, reason: 'signature mismatch' };
  },
}));

import { createMcpRoute, McpToolError, type McpDeclarationFile } from '../src/templates/next-js/lib/mcp';

const declared: McpDeclarationFile = {
  tools: [
    {
      name: 'echo',
      description: 'Echo.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' }, count: { type: 'integer' } },
        required: ['text'],
      },
      endpoint: '/mcp',
      read_only: true,
    },
    {
      name: 'make',
      description: 'Make a thing.',
      input_schema: { type: 'object', properties: {} },
      endpoint: '/mcp',
      read_only: false,
    },
  ],
};

let n = 0;
function signedRequest(
  body: Record<string, unknown>,
  opts: { secret?: string; event?: string; ts?: number; raw?: string; delivery?: string } = {},
): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${ts}.${raw}`).digest('hex');
  return new Request('https://app.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-app-event': opts.event ?? 'mcp.tool_call',
      'x-app-signature': sig,
      'x-app-timestamp': ts,
      'x-app-delivery': opts.delivery ?? String(body.request_id ?? `d${++n}`),
    },
    body: raw,
  });
}

function call(tool: string, args: Record<string, unknown>, profileId: unknown = 7, requestId = `r${++n}`) {
  return { tool, arguments: args, profile_id: profileId, request_id: requestId };
}

function route(handlers: Record<string, any> = {}) {
  return createMcpRoute({
    secret: () => SECRET,
    declared,
    handlers: { echo: async ({ args }: any) => ({ said: args.text }), make: async () => ({ made: true }), ...handlers },
  });
}

describe('starter lib/mcp.ts ships as a kit file', () => {
  it('carries the template marker header', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'templates', 'next-js', 'lib', 'mcp.ts'), 'utf8');
    expect(src.startsWith('/* @flashmandu-template lib/mcp.ts@')).toBe(true);
  });

  it('the template route mounts the factory on the declared tools file', () => {
    const tpl = path.join(__dirname, '..', 'src', 'templates', 'next-js');
    const routeSrc = readFileSync(path.join(tpl, 'app', 'mcp', 'route.ts'), 'utf8');
    expect(routeSrc).toMatch(/createMcpRoute/);
    expect(routeSrc).toMatch(/mcp-tools\.json/);
    const file = JSON.parse(readFileSync(path.join(tpl, 'mcp-tools.json'), 'utf8'));
    expect(Array.isArray(file.tools)).toBe(true);
  });
});

describe('createMcpRoute', () => {
  it('refuses to build when a declared tool has no handler or a handler is undeclared', () => {
    expect(() => createMcpRoute({ secret: () => SECRET, declared, handlers: { echo: async () => 1 } })).toThrow(/make/);
    expect(() =>
      createMcpRoute({ secret: () => SECRET, declared, handlers: { echo: async () => 1, make: async () => 1, ghost: async () => 1 } }),
    ).toThrow(/ghost/);
  });

  it('runs a declared tool for the SIGNED profile and wraps the result', async () => {
    const seen: any[] = [];
    const { POST } = route({ echo: async (ctx: any) => { seen.push(ctx); return { said: ctx.args.text }; } });
    const res = await POST(signedRequest(call('echo', { text: 'hi' }, 7, 'req-1')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { said: 'hi' } });
    expect(seen[0]).toMatchObject({ profileId: 7, requestId: 'req-1', args: { text: 'hi' } });
  });

  it('never trusts an arguments.profile_id: it is dropped before the handler sees args', async () => {
    const seen: any[] = [];
    const { POST } = route({ echo: async (ctx: any) => { seen.push(ctx); return 1; } });
    await POST(signedRequest(call('echo', { text: 'x', profile_id: 999 }, 7)));
    expect(seen[0].profileId).toBe(7);
    expect('profile_id' in seen[0].args).toBe(false);
  });

  it('401s a bad signature, a wrong secret, a tampered body and a stale timestamp, without running anything', async () => {
    const handler = vi.fn(async () => 1);
    const { POST } = route({ echo: handler });
    const body = call('echo', { text: 'x' });
    const tampered = signedRequest(body);
    const forged = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: JSON.stringify({ ...body, profile_id: 8 }) });
    for (const req of [
      signedRequest(body, { secret: 'wrong' }),
      forged,
      signedRequest(body, { ts: Math.floor(Date.now() / 1000) - 3600 }),
      new Request('https://app.example/mcp', { method: 'POST', body: JSON.stringify(body) }),
    ]) {
      const res = await POST(req);
      expect(res.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('400s a signed request for another event, a bad profile_id or a non-object arguments', async () => {
    const { POST } = route();
    expect((await POST(signedRequest(call('echo', { text: 'x' }), { event: 'app.uninstalled' }))).status).toBe(400);
    for (const pid of [0, -1, 1.5, '7', null]) {
      expect((await POST(signedRequest(call('echo', { text: 'x' }, pid)))).status).toBe(400);
    }
    expect((await POST(signedRequest({ tool: 'echo', arguments: [1], profile_id: 7, request_id: 'q' }))).status).toBe(400);
    expect((await POST(signedRequest({}, { raw: 'not json' }))).status).toBe(400);
  });

  it('404s an undeclared tool', async () => {
    const res = await route().POST(signedRequest(call('drop_tables', {})));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('unknown_tool');
  });

  it('answers invalid arguments as a tool error (200, ok:false) so the agent can correct itself', async () => {
    const handler = vi.fn(async () => 1);
    const { POST } = route({ echo: handler });
    for (const args of [{}, { text: 5 }, { text: 'x', count: 1.5 }]) {
      const res = await POST(signedRequest(call('echo', args)));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('invalid_arguments');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops undeclared argument keys', async () => {
    const seen: any[] = [];
    const { POST } = route({ echo: async (ctx: any) => { seen.push(ctx.args); return 1; } });
    await POST(signedRequest(call('echo', { text: 'x', sneaky: true })));
    expect(seen[0]).toEqual({ text: 'x' });
  });

  it('a McpToolError becomes {ok:false,error}; any other throw is a generic 500', async () => {
    const { POST } = route({
      echo: async () => { throw new McpToolError('not_found', 'Tour not found.'); },
      make: async () => { throw new Error('SELECT * FROM secrets failed'); },
    });
    const a = await POST(signedRequest(call('echo', { text: 'x' })));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: false, error: { code: 'not_found', message: 'Tour not found.' } });
    const b = await POST(signedRequest(call('make', {})));
    expect(b.status).toBe(500);
    expect(JSON.stringify(await b.json())).not.toMatch(/secrets/);
  });

  it('runs a WRITE tool at most once per request id (replay inside the skew window)', async () => {
    const make = vi.fn(async () => ({ made: true }));
    const { POST } = route({ make });
    const body = call('make', {}, 7, 'same-id');
    expect((await POST(signedRequest(body))).status).toBe(200);
    expect((await POST(signedRequest(body))).status).toBe(409);
    expect(make).toHaveBeenCalledTimes(1);
  });
});
