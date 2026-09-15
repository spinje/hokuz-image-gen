#!/usr/bin/env node
/**
 * An MCP server for generating and editing images using the Nano Banana
 * family of Google Gemini image models (Nano Banana 2 / 2 Lite / Pro).
 *
 * Tools:
 * - hokuz_generate_image: Generate images from text prompts
 * - hokuz_edit_image: Edit existing images using text instructions
 *
 * Environment Variables:
 * - GEMINI_API_KEY (preferred) or GOOGLE_API_KEY: Your Google AI Studio API key
 *
 * Usage:
 * - Local (stdio): node dist/index.js
 * - Get API key at: https://aistudio.google.com/
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateApiKey } from "./services/gemini-client.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { ENV_VARS } from "./constants.js";

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

  const server = createServer();

  // Create stdio transport for local communication
  const transport = new StdioServerTransport();

  // Connect and start serving
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio`);
  console.error("Tools available:");
  console.error("  - hokuz_generate_image: Generate images from text prompts");
  console.error("  - hokuz_edit_image: Edit images using text instructions");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
