/**
 * MCP server construction.
 *
 * Kept separate from index.ts so tests can build a server and drive it over an
 * in-memory transport without triggering the stdio startup in main().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGenerateImageTool } from "./tools/generate-image.js";
import { registerEditImageTool } from "./tools/edit-image.js";
import { SERVER_NAME, SERVER_VERSION } from "./package-info.js";

/**
 * Shown by clients before any tool schema is loaded (Claude Code defers MCP
 * tools behind a search), so it says what a caller must know before preparing
 * inputs. Same character budget as the descriptions (CLAUDE.md gotcha 8).
 */
const INSTRUCTIONS = "hokuz_generate_image and hokuz_edit_image generate and edit images with Gemini or OpenAI models and save them as local files. " +
  "Load a tool's schema before preparing its inputs: hokuz_edit_image accepts public HTTP(S) image URLs in image_paths " +
  "directly, so do not download them first. In results, images[].path is authoritative, and width/height are the delivered " +
  "pixel size, which can differ slightly from the requested aspect_ratio. settings gives the model and options the requests " +
  "were built with, including defaults; cite it rather than your own arguments.";

/**
 * Create and configure the MCP server with all tools registered.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  registerGenerateImageTool(server);
  registerEditImageTool(server);

  return server;
}
