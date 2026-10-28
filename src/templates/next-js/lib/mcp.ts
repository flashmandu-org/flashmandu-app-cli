/* @flashmandu-template lib/mcp.ts@0.6.1 */
/**
 * Your app's MCP tools, called by merchants' AI agents through the platform.
 *
 * HOW A CALL ARRIVES. The platform never runs your code: it POSTs one signed
 * request per tool call to the tool's `endpoint` on your app's origin:
 *
 *   headers  X-App-Event: mcp.tool_call
 *            X-App-Signature: hex(hmac_sha256("{timestamp}.{raw body}", webhook_secret))
 *            X-App-Timestamp, X-App-Delivery (= request_id)
 *   body     { "tool": "...", "arguments": {...}, "profile_id": 123, "request_id": "uuid",
 *              "api_token": "..." }
 *
 * It is the same signature as webhooks, verified with the bridge's
 * `verifyWebhook` over the RAW body. The platform has already checked the
 * merchant's toggle, the plan and your GRANTED scopes before it sends.
 *
 * HOST CALLS. `api_token` (signed with the body, newer hosts) is a SHORT-LIVED
 * install token for `profile_id`; handlers get it as `ctx.apiToken` and use it
 * as the Bearer for host calls (`createFlashmanduClient({ apiBase:
 * loadConfig().apiBase, token: ctx.apiToken })`). It is null from an older
 * host: refuse host work then, never fall back to the pod's own token (that
 * one is pinned to a single install). Never log or return it.
 *
 * TENANCY. Act ONLY for the signed top-level `profile_id`. Any `profile_id`
 * inside `arguments` is dropped before your handler runs (the platform strips
 * it too); never accept a profile id as a tool argument.
 *
 * DECLARATION. The tools live in `mcp-tools.json` (`{ "tools": [...] }`,
 * the platform's `McpTool` shape: name, description, input_schema, endpoint,
 * scopes, read_only). The manifest points at it (`[mcp] tools_file =
 * "mcp-tools.json"`) and the CLI sends it on `dev`/`push`/`deploy`; your route
 * imports the SAME file, so what agents are offered and what you dispatch
 * cannot drift. Every declared tool needs a handler and vice versa.
 *
 * ANSWERS. 200 `{ok:true,result}`; a `McpToolError` (or invalid arguments) is
 * 200 `{ok:false,error:{code,message}}` so the agent can correct itself; any
 * other throw is a generic 500 (internals never leave the app). The platform
 * marks every answer as untrusted third-party content and caps its size.
 */

import { verifyWebhook } from '@flashmandu/app-bridge/server';

export const MCP_EVENT = 'mcp.tool_call';

export interface McpToolDeclaration {
  name: string;
  description: string;
  input_schema: {
    type: 'object' | string;
    properties?: Record<string, { type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
  endpoint: string;
  scopes?: string[];
  read_only?: boolean;
}

export interface McpDeclarationFile {
  tools: McpToolDeclaration[];
}

export interface McpCallContext {
  /** The SIGNED profile the call acts for. The only tenant you may touch. */
  profileId: number;
  /** Declared arguments only (undeclared keys and any profile_id dropped). */
  args: Record<string, unknown>;
  /** The platform's request id (also X-App-Delivery). */
  requestId: string;
  /** The signed body's short-lived install `api_token` for host calls; null from an older host. */
  apiToken: string | null;
}

export type McpHandler = (ctx: McpCallContext) => Promise<unknown> | unknown;

/** Throw from a handler to answer `{ ok: false, error: { code, message } }`. */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface CreateMcpRouteOptions {
  /** The install's webhook secret, read lazily (e.g. `() => loadConfig().webhookSecret`). */
  secret: () => string;
  declared: McpDeclarationFile;
  handlers: Record<string, McpHandler>;
  maxSkewSeconds?: number;
  /**
   * PERSISTENT replay guard for WRITE tools: record `requestId` and return
   * true when it was already recorded (e.g. a unique row in your database,
   * kept longer than the signature skew window). Consulted AFTER the
   * per-process in-memory guard, which always runs first; with more than one
   * instance only this hook catches a replay sent to another pod.
   */
  seenRequest?: (requestId: string) => Promise<boolean> | boolean;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function fail(code: string, message: string, status = 200): Response {
  return json({ ok: false, error: { code, message } }, status);
}

function memorySeen(limit = 5000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > limit) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeMatches(type: string | undefined, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

/** Keep declared keys only; check required keys and primitive types. */
function checkArguments(tool: McpToolDeclaration, raw: Record<string, unknown>): Record<string, unknown> | string {
  const props = tool.input_schema.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    if (key === 'profile_id' || !(key in raw) || raw[key] === undefined) continue;
    if (!typeMatches(spec.type, raw[key])) {
      return `"${key}" must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}.`;
    }
    args[key] = raw[key];
  }
  for (const key of tool.input_schema.required ?? []) {
    if (!(key in args)) {
      return `"${key}" is required.`;
    }
  }
  return args;
}

/** A Next.js route handler (`export const { POST } = createMcpRoute(...)`). */
export function createMcpRoute(opts: CreateMcpRouteOptions): { POST: (req: Request) => Promise<Response> } {
  const tools = new Map(opts.declared.tools.map((t) => [t.name, t]));
  const missing = [...tools.keys()].filter((name) => !(name in opts.handlers));
  const extra = Object.keys(opts.handlers).filter((name) => !tools.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `MCP tools and handlers disagree: ${[
        missing.length ? `no handler for ${missing.join(', ')}` : '',
        extra.length ? `undeclared handler ${extra.join(', ')}` : '',
      ].filter(Boolean).join('; ')}.`,
    );
  }
  const seenInMemory = memorySeen();
  const seenRequest = async (id: string): Promise<boolean> =>
    seenInMemory(id) || (opts.seenRequest !== undefined && (await opts.seenRequest(id)));

  return {
    async POST(req: Request): Promise<Response> {
      const raw = await req.text();
      const verified = verifyWebhook({
        rawBody: raw,
        headers: req.headers,
        secret: opts.secret(),
        ...(opts.maxSkewSeconds !== undefined ? { maxSkewSeconds: opts.maxSkewSeconds } : {}),
      });
      if (!verified.ok) {
        return fail('unauthorized', verified.reason ?? 'Invalid signature.', 401);
      }
      if ((verified.event ?? req.headers.get('x-app-event')) !== MCP_EVENT) {
        return fail('wrong_event', `Expected X-App-Event ${MCP_EVENT}.`, 400);
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail('invalid_body', 'The body is not JSON.', 400);
      }
      if (!isRecord(body)) {
        return fail('invalid_body', 'The body must be an object.', 400);
      }
      const profileId = body.profile_id;
      if (typeof profileId !== 'number' || !Number.isInteger(profileId) || profileId <= 0) {
        return fail('invalid_body', 'profile_id must be a positive integer.', 400);
      }
      const rawArgs = body.arguments ?? {};
      if (!isRecord(rawArgs)) {
        return fail('invalid_body', 'arguments must be an object.', 400);
      }
      const tool = typeof body.tool === 'string' ? tools.get(body.tool) : undefined;
      if (tool === undefined) {
        return fail('unknown_tool', 'This app declares no such tool.', 404);
      }
      const requestId = typeof body.request_id === 'string' ? body.request_id : (verified.deliveryId ?? '');

      const args = checkArguments(tool, rawArgs);
      if (typeof args === 'string') {
        return fail('invalid_arguments', args);
      }

      if (tool.read_only === false && requestId !== '' && (await seenRequest(requestId))) {
        return fail('duplicate_request', 'This call was already handled.', 409);
      }

      try {
        const apiToken = typeof body.api_token === 'string' && body.api_token !== '' ? body.api_token : null;
        const result = await opts.handlers[tool.name]({ profileId, args, requestId, apiToken });
        return json({ ok: true, result: result ?? null }, 200);
      } catch (err) {
        if (err instanceof McpToolError) {
          return fail(err.code, err.message);
        }
        console.error(`[mcp] ${tool.name} failed for profile=${profileId}`, err);
        return fail('internal_error', 'The tool failed.', 500);
      }
    },
  };
}
