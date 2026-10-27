/**
 * Signed MCP endpoint (`POST /mcp`). See lib/mcp.ts for the wire contract.
 *
 * To offer a tool: add it to mcp-tools.json (endpoint "/mcp"), add
 * `[mcp] tools_file = "mcp-tools.json"` to flashmandu.app.toml, and add its
 * handler below. Use ONLY `ctx.profileId` (the signed profile) for tenancy.
 *
 *   handlers: {
 *     list_items: async ({ profileId }) => db.item.findMany({ where: { profileId } }),
 *   },
 */

import { loadConfig } from '@flashmandu/app-bridge/server';

import { createMcpRoute, type McpDeclarationFile } from '@/lib/mcp';
import declared from '@/mcp-tools.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const { POST } = createMcpRoute({
  secret: () => loadConfig().webhookSecret,
  declared: declared as McpDeclarationFile,
  handlers: {},
});
