import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AppManifest } from './manifest';

/**
 * The app's declared MCP tool surface (`[mcp]` in the manifest), resolved into
 * the `mcp: { tools: [...] }` payload the host's `/api/apps/dev/register` and
 * `/api/apps/app-submissions` accept (both store it only through
 * `AppManager::normalizeMcpSurface()`).
 *
 * Declared either inline (`[[mcp.tools]]`) or in `tools_file` (JSON, relative
 * to the app dir). The starter's `app/mcp/route.ts` imports the SAME file, so
 * what the host advertises and what the app dispatches cannot drift.
 *
 * `validateMcpTools` mirrors the SDK (`Flashmandu\AppSdk\Mcp\McpTool`,
 * `McpSurface`) and the host bounds (`McpSurfaceLimits` defaults), so a bad
 * declaration fails at `push`/`dev` time with a sentence, not a 422.
 */

export interface McpToolPayload {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  endpoint: string;
  scopes: string[];
  read_only: boolean;
}

export interface McpSurfacePayload {
  tools: McpToolPayload[];
}

/** `McpTool::NAME_PATTERN`. */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** `McpTool::ENDPOINT_PATTERN`. */
const ENDPOINT_RE = /^(\/[A-Za-z0-9._~-]+)+\/?$/;
/** `McpTool::RESERVED_INPUTS` — the host injects these. */
const RESERVED_INPUTS = ['profile_id'];
/** `config('apps.mcp_proxy.*')` defaults read by `McpSurfaceLimits`. */
const MAX_TOOLS = 50;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_INPUT_SCHEMA_BYTES = 16384;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every problem with `tools`, as sentences; empty when valid. */
export function validateMcpTools(tools: unknown[], appScopes: readonly string[]): string[] {
  const errors: string[] = [];
  if (tools.length > MAX_TOOLS) {
    errors.push(`declares ${tools.length} MCP tools; the platform limit is ${MAX_TOOLS}`);
  }
  const seen = new Set<string>();
  tools.forEach((raw, i) => {
    const t = isRecord(raw) ? raw : {};
    const name = typeof t.name === 'string' ? t.name : '';
    const label = `mcp tool #${i + 1}${name ? ` "${name}"` : ''}`;
    if (!NAME_RE.test(name)) {
      errors.push(`${label}: name must be snake_case, start with a letter, max 64 chars`);
    } else if (seen.has(name)) {
      errors.push(`${label}: duplicate tool name`);
    }
    seen.add(name);

    const description = typeof t.description === 'string' ? t.description : '';
    if (description.trim() === '') {
      errors.push(`${label}: description must not be empty`);
    } else if ([...description].length > MAX_DESCRIPTION_CHARS) {
      errors.push(`${label}: description is over ${MAX_DESCRIPTION_CHARS} characters`);
    }

    const schema = t.input_schema;
    if (!isRecord(schema) || schema.type !== 'object') {
      errors.push(`${label}: input_schema must declare type "object"`);
    } else {
      const props = schema.properties;
      if (isRecord(props)) {
        for (const reserved of RESERVED_INPUTS) {
          if (reserved in props) {
            errors.push(`${label}: input_schema must not declare "${reserved}"; the host injects it`);
          }
        }
      }
      const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
      if (bytes > MAX_INPUT_SCHEMA_BYTES) {
        errors.push(`${label}: input_schema is ${bytes} bytes; the limit is ${MAX_INPUT_SCHEMA_BYTES}`);
      }
    }

    const endpoint = typeof t.endpoint === 'string' ? t.endpoint : '';
    const segments = endpoint.split('/');
    if (!ENDPOINT_RE.test(endpoint) || segments.includes('.') || segments.includes('..')) {
      errors.push(`${label}: endpoint must be a plain path on the app's own origin, like "/mcp"`);
    }

    const scopes = Array.isArray(t.scopes) ? t.scopes : [];
    for (const scope of scopes) {
      if (typeof scope !== 'string' || !appScopes.includes(scope)) {
        errors.push(`${label}: scope "${String(scope)}" is not in the app's own scopes`);
      }
    }
    if (t.read_only !== undefined && typeof t.read_only !== 'boolean') {
      errors.push(`${label}: read_only must be true or false`);
    }
  });
  return errors;
}

function toPayload(raw: Record<string, unknown>): McpToolPayload {
  return {
    name: String(raw.name),
    description: String(raw.description),
    input_schema: raw.input_schema as Record<string, unknown>,
    endpoint: String(raw.endpoint),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : [],
    read_only: raw.read_only === undefined ? true : Boolean(raw.read_only),
  };
}

/**
 * The validated host payload for the app's `[mcp]` table, or undefined when
 * the app declares none. Throws (naming the file) on a missing, escaping,
 * unparsable or invalid declaration.
 */
export async function resolveMcpSurface(manifest: AppManifest, appDir: string): Promise<McpSurfacePayload | undefined> {
  const mcp = manifest.mcp;
  if (mcp === undefined) {
    return undefined;
  }
  let tools: unknown[] = Array.isArray(mcp.tools) ? mcp.tools : [];
  let source = 'flashmandu.app.toml [[mcp.tools]]';

  if (tools.length === 0 && mcp.tools_file) {
    source = mcp.tools_file;
    const root = path.resolve(appDir);
    const abs = path.resolve(root, mcp.tools_file);
    if (!abs.startsWith(root + path.sep)) {
      throw new Error(`[mcp] tools_file "${mcp.tools_file}" must be a file inside the app directory.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(abs, 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[mcp] tools_file "${mcp.tools_file}" could not be read: ${msg}`);
    }
    tools = isRecord(parsed) && Array.isArray(parsed.tools) ? parsed.tools : [];
  }

  const errors = validateMcpTools(tools, manifest.scopes ?? []);
  if (errors.length > 0) {
    throw new Error(`MCP declaration in ${source} is invalid:\n  • ${errors.join('\n  • ')}`);
  }
  return { tools: tools.map((t) => toPayload(t as Record<string, unknown>)) };
}
