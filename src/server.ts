/**
 * MCP server construction.
 *
 * Kept separate from index.ts so tests can build a server and drive it over an
 * in-memory transport without triggering the stdio startup in main().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGenerateImageTool } from "./tools/generate-image.js";
import { registerEditImageTool } from "./tools/edit-image.js";

/** Server metadata */
export const SERVER_NAME = "nano-banana-mcp-server";
export const SERVER_VERSION = "1.0.0";

/**
 * Create and configure the MCP server with all tools registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerGenerateImageTool(server);
  registerEditImageTool(server);

  return server;
}
