#!/usr/bin/env node
/**
 * Nano Banana MCP Server
 *
 * An MCP server for generating and editing images using the Nano Banana
 * family of Google Gemini image models (Nano Banana 2 / 2 Lite / Pro).
 *
 * Tools:
 * - nanobanana_generate_image: Generate images from text prompts
 * - nanobanana_edit_image: Edit existing images using text instructions
 *
 * Environment Variables:
 * - GEMINI_API_KEY (preferred) or GOOGLE_API_KEY: Your Google AI Studio API key
 *
 * Usage:
 * - Local (stdio): node dist/index.js
 * - Get API key at: https://aistudio.google.com/
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateApiKey } from "./services/gemini-client.js";
import { registerGenerateImageTool } from "./tools/generate-image.js";
import { registerEditImageTool } from "./tools/edit-image.js";
import { ENV_VARS } from "./constants.js";

/**
 * Server metadata
 */
const SERVER_NAME = "nano-banana-mcp-server";
const SERVER_VERSION = "1.0.0";

/**
 * Create and configure the MCP server
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tools
  registerGenerateImageTool(server);
  registerEditImageTool(server);

  return server;
}

/**
 * Main entry point - runs the server with stdio transport
 */
async function main(): Promise<void> {
  // Validate API key is present before starting
  try {
    validateApiKey();
  } catch {
    console.error(
      `ERROR: ${ENV_VARS.geminiApiKey} or ${ENV_VARS.googleApiKey} environment variable is required.`
    );
    console.error("Get your API key at: https://aistudio.google.com/");
    process.exit(1);
  }

  // Create the server
  const server = createServer();

  // Create stdio transport for local communication
  const transport = new StdioServerTransport();

  // Connect and start serving
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio`);
  console.error("Tools available:");
  console.error("  - nanobanana_generate_image: Generate images from text prompts");
  console.error("  - nanobanana_edit_image: Edit images using text instructions");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
