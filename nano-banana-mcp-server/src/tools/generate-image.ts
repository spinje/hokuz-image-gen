/**
 * Generate Image Tool Implementation
 *
 * Generates images from text prompts using Nano Banana Pro (Gemini 3 Pro Image).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GenerateImageInputSchema,
  GenerateImageOutputSchema,
  type GenerateImageOutput,
} from "../schemas/generate.js";
import { generateImage } from "../services/gemini-client.js";
import {
  resolveOutputPath,
  saveBase64Image,
} from "../services/file-utils.js";
import { McpError } from "../types.js";
import { DEFAULTS, type OutputFormat } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Generate images from text prompts using Nano Banana Pro (Google's Gemini 3 Pro Image model).

This tool creates high-quality AI-generated images based on your text description. It supports:
- Multiple aspect ratios (1:1, 16:9, 9:16, etc.)
- Resolutions up to 4K
- Multiple output formats (PNG, JPEG, WebP)
- Generating 1-4 images per request
- Temperature control for creativity

Args:
  - prompt (string, required): Detailed text description of the image to generate
  - output_path (string, required): File path to save the image. Can be a directory (filename will be auto-generated with timestamp) or a full file path
  - aspect_ratio (string, optional): Image aspect ratio. Default: "1:1"
  - resolution (string, optional): Image quality - "1K", "2K", or "4K". Default: "1K"
  - output_format (string, optional): Output format - "png", "jpeg", or "webp". Default: "png"
  - num_images (number, optional): Number of images to generate (1-4). Default: 1
  - temperature (number, optional): Creativity level 0.0-2.0. Higher = more creative. Default: 1.0

Returns:
  {
    "success": boolean,
    "images": [
      {
        "path": string (if output_path provided),
        "dataUrl": string (if no output_path),
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
      title: "Generate Image with Nano Banana Pro",
      description: TOOL_DESCRIPTION,
      inputSchema: GenerateImageInputSchema,
      outputSchema: GenerateImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Creates files when output_path provided
        destructiveHint: false, // Doesn't delete existing data
        idempotentHint: false, // Same prompt produces different images
        openWorldHint: true, // Interacts with external Google API
      },
    },
    async (params) => {
      try {
        // Apply defaults for optional parameters
        const aspectRatio = params.aspect_ratio ?? DEFAULTS.aspectRatio;
        const resolution = params.resolution ?? DEFAULTS.resolution;
        const temperature = params.temperature ?? DEFAULTS.temperature;
        const numImages = params.num_images ?? DEFAULTS.numImages;
        const outputFormat = (params.output_format ?? DEFAULTS.outputFormat) as OutputFormat;

        // Call the Gemini API to generate images
        const response = await generateImage(params.prompt, {
          aspectRatio,
          resolution,
          temperature,
          numImages,
        });

        // Process the generated images - save to files
        const outputImages: GenerateImageOutput["images"] = [];

        for (let i = 0; i < response.images.length; i++) {
          const image = response.images[i];
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

        const output: GenerateImageOutput = {
          success: true,
          images: outputImages,
          description: response.description,
        };

        // Format response text
        const paths = outputImages.map((img) => img.path).join("\n  ");
        let textContent = `Successfully generated ${outputImages.length} image(s):\n  ${paths}`;
        if (response.description) {
          textContent += `\n\nDescription: ${response.description}`;
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
