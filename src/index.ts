#!/usr/bin/env node
/**
 * An MCP server for generating and editing images with Google's Nano Banana
 * (Gemini) image models and OpenAI's GPT Image 2.5 models.
 *
 * Tools:
 * - hokuz_generate_image: Generate images from text prompts
 * - hokuz_edit_image: Edit existing images using text instructions
 *
 * Environment Variables:
 * - GEMINI_API_KEY (preferred) or GOOGLE_API_KEY: Google AI Studio API key
 * - OPENAI_API_KEY: OpenAI API key
 * At least one is required; models of a provider whose key is missing fail
 * with an error naming the variable.
 *
 * Usage:
 * - Local (stdio): node dist/index.js
 * - Get API keys at https://aistudio.google.com/ and https://platform.openai.com/
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { enabledProviders, providerLabel } from "./providers/index.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { ENV_VARS } from "./constants.js";

/**
 * Main entry point - runs the server with stdio transport
 */
async function main(): Promise<void> {
  const providers = enabledProviders();

  if (providers.length === 0) {
    console.error(
      `ERROR: No provider API key found. Set ${ENV_VARS.geminiApiKey} (or ${ENV_VARS.googleApiKey}) for Gemini models and/or ${ENV_VARS.openaiApiKey} for GPT Image models.`
    );
    process.exit(1);
  }

  const server = createServer();

  // Create stdio transport for local communication
  const transport = new StdioServerTransport();

  // Connect and start serving
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio`);
  console.error(
    `Providers enabled: ${providers.map(providerLabel).join(", ")}`
  );
  console.error("Tools available:");
  console.error("  - hokuz_generate_image: Generate images from text prompts");
  console.error("  - hokuz_edit_image: Edit images using text instructions");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
