/**
 * Generate Image Tool Implementation
 *
 * Generates images from text prompts using the Nano Banana image models
 * (Nano Banana 2 / 2 Lite / Pro) via the Gemini Interactions API.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GenerateImageInputSchema,
  GenerateImageOutputSchema,
  type GenerateImageOutput,
} from "../schemas/generate.js";
import {
  generateImage,
  validateGenerationConfig,
  type GenerationConfig,
} from "../services/gemini-client.js";
import {
  resolveOutputPath,
  saveBase64Image,
  resolveRequestedOutputFormat,
} from "../services/file-utils.js";
import { McpError, type GeneratedImage } from "../types.js";
import { DEFAULTS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Generate images from text prompts using the Nano Banana image models (Google's Gemini image models).

This tool creates high-quality AI-generated images based on your text description. It supports:
- Selectable models: Nano Banana 2 (gemini-3.1-flash-image, default), Nano Banana 2 Lite (gemini-3.1-flash-lite-image), and Nano Banana Pro (gemini-3-pro-image)
- Multiple aspect ratios (1:1, 16:9, 9:16, etc.)
- Resolutions up to 4K (model-dependent: Lite is 1K only)
- Output format: JPEG (the only format these models produce)
- Generating 1-4 images per request
- Temperature control for creativity

Unsupported model/resolution or model/aspect-ratio combinations are rejected before any API call (no silent downgrades).

Choosing a model (approximate speed for a 1K image and per-image cost; verify current prices at https://ai.google.dev/gemini-api/docs/pricing):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): fastest (~5s), cheapest (~$0.034), 1K only. Use for drafts, thumbnails, and high-volume batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): balanced (~11s), ~$0.045-$0.15 depending on resolution (0.5K-4K), supports extreme aspect ratios. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): highest quality but slowest (~17s), ~$0.13 (1K/2K) to ~$0.24 (4K), 1K-4K. Use for hero shots, photorealism, and cinematic lighting.
Higher resolutions are slower and cost more. num_images > 1 makes that many separate requests, so time and cost scale linearly.

Args:
  - prompt (string, required): Detailed text description of the image to generate
  - output_path (string, required): File path to save the image. Can be a directory (filename will be auto-generated with timestamp) or a full file path
  - model (string, optional): "gemini-3.1-flash-image" (default), "gemini-3.1-flash-lite-image", or "gemini-3-pro-image"
  - aspect_ratio (string, optional): Image aspect ratio. Default: "1:1"
  - resolution (string, optional): Image quality - "0.5K", "1K", "2K", or "4K". Default: "1K"
  - output_format (string, optional): Output format - only "jpeg" is supported. Default: "jpeg"
  - num_images (number, optional): Number of images to generate (1-4). Default: 1
  - temperature (number, optional): Creativity level 0.0-2.0. Higher = more creative. Default: 1.0

Returns:
  {
    "success": boolean,
    "images": [
      {
        "path": string,
        "format": string
      }
    ],
    "description": string (model's description of generated image),
    "error": string (if failed)
  }

Examples:
  - Generate a landscape: prompt="A serene mountain lake at sunset with snow-capped peaks", aspect_ratio="16:9"
  - Generate a portrait: prompt="Professional headshot of a confident businesswoman", aspect_ratio="3:4", output_path="~/images/"
  - Generate multiple variations: prompt="Abstract art with vibrant colors", num_images=4, temperature=1.5`;

/**
 * Register the generate_image tool with the MCP server
 */
export function registerGenerateImageTool(server: McpServer): void {
  server.registerTool(
    "nanobanana_generate_image",
    {
      title: "Generate Image with Nano Banana",
      description: TOOL_DESCRIPTION,
      inputSchema: GenerateImageInputSchema,
      outputSchema: GenerateImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Always writes the result to output_path
        destructiveHint: false, // Doesn't delete existing data
        idempotentHint: false, // Same prompt produces different images
        openWorldHint: true, // Interacts with external Google API
      },
    },
    async (params) => {
      try {
        // The SDK has already applied the schema's .default() values; these fallbacks
        // are defence in depth only. Optionality is decided by .default() in the schema.
        const model = params.model ?? DEFAULTS.model;
        const aspectRatio = params.aspect_ratio ?? DEFAULTS.aspectRatio;
        const resolution = params.resolution ?? DEFAULTS.resolution;
        const temperature = params.temperature ?? DEFAULTS.temperature;
        const requestedCount = params.num_images ?? DEFAULTS.numImages;
        const outputFormat = resolveRequestedOutputFormat(
          params.output_path,
          params.output_format
        );

        const config: GenerationConfig = {
          model,
          aspectRatio,
          resolution,
          temperature,
          outputFormat,
        };

        // Validate model options before any API call (fail fast, no downgrades)
        validateGenerationConfig(config);

        // num_images is implemented via repeated independent requests, each
        // asking for one image. Stop once we have enough.
        const collected: GeneratedImage[] = [];
        const descriptions: string[] = [];
        for (
          let attempt = 0;
          collected.length < requestedCount && attempt < requestedCount;
          attempt++
        ) {
          try {
            const response = await generateImage(params.prompt, config);
            collected.push(...response.images);
            if (response.description) descriptions.push(response.description);
          } catch (err) {
            // If we have no images yet, surface the error. Otherwise keep what
            // we got and warn that fewer than requested were produced.
            if (collected.length === 0) throw err;
            break;
          }
        }

        const imagesToSave = collected.slice(0, requestedCount);

        // Process the generated images - save to files
        const outputImages: GenerateImageOutput["images"] = [];

        for (let i = 0; i < imagesToSave.length; i++) {
          const image = imagesToSave[i];
          const filePath = await resolveOutputPath(
            params.output_path,
            outputFormat,
            i
          );
          await saveBase64Image(image.data, filePath);

          outputImages.push({
            path: filePath,
            format: outputFormat,
          });
        }

        const description = descriptions.length
          ? Array.from(new Set(descriptions)).join("\n---\n")
          : undefined;

        const output: GenerateImageOutput = {
          success: true,
          images: outputImages,
          description,
        };

        // Format response text
        const paths = outputImages.map((img) => img.path).join("\n  ");
        let textContent = `Successfully generated ${outputImages.length} image(s):\n  ${paths}`;
        if (outputImages.length < requestedCount) {
          textContent += `\n\nWarning: requested ${requestedCount} image(s) but only ${outputImages.length} were produced.`;
        }
        if (description) {
          textContent += `\n\nDescription: ${description}`;
        }

        return {
          content: [{ type: "text", text: textContent }],
          structuredContent: output,
        };
      } catch (error) {
        const errorMessage =
          error instanceof McpError
            ? error.message
            : `Error: Unexpected error during image generation. ${error instanceof Error ? error.message : String(error)}`;

        const output: GenerateImageOutput = {
          success: false,
          images: [],
          error: errorMessage,
        };

        return {
          content: [{ type: "text", text: errorMessage }],
          structuredContent: output,
          isError: true,
        };
      }
    }
  );
}
