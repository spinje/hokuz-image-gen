/**
 * Edit Image Tool Implementation
 *
 * Edits existing images using text prompts with the Nano Banana image models
 * (Nano Banana 2 / 2 Lite / Pro) via the Gemini Interactions API.
 * Supports style transfer, image modification, and multi-image composition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EditImageInputSchema,
  EditImageOutputSchema,
  type EditImageOutput,
} from "../schemas/edit.js";
import {
  editImage,
  validateGenerationConfig,
  type GenerationConfig,
} from "../services/gemini-client.js";
import {
  resolveOutputPath,
  saveBase64Image,
  loadImage,
  resolveRequestedOutputFormat,
} from "../services/file-utils.js";
import { McpError, type InputImage, type GeneratedImage } from "../types.js";
import { DEFAULTS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit images using text prompts with the Nano Banana image models (Google's Gemini image models).

This tool modifies existing images based on your instructions. It supports:
- Selectable models: Nano Banana 2 (gemini-3.1-flash-image, default), Nano Banana 2 Lite (gemini-3.1-flash-lite-image), and Nano Banana Pro (gemini-3-pro-image)
- Basic editing: "Remove the background", "Make it brighter", "Crop to focus on the face"
- Style transfer: Apply artistic styles from reference images
- Character consistency: Maintain character identity across different poses/scenes
- Multi-image composition: Combine up to 14 images into new compositions
- Colorization: Convert black & white photos to color
- Object manipulation: Move, add, or remove objects

Unsupported model/resolution or model/aspect-ratio combinations are rejected before any API call (no silent downgrades).

Choosing a model (approximate speed for a 1K image and per-image cost; verify current prices at https://ai.google.dev/gemini-api/docs/pricing):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): fastest (~5s), cheapest (~$0.034), 1K only. Use for quick edits and high-volume batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): balanced (~11s), ~$0.045-$0.15 depending on resolution (0.5K-4K), supports extreme aspect ratios. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): highest quality but slowest (~17s), ~$0.13 (1K/2K) to ~$0.24 (4K), 1K-4K. Use for photorealistic and high-fidelity edits.
Higher resolutions are slower and cost more. num_images > 1 makes that many separate requests, so time and cost scale linearly.

Args:
  - prompt (string, required): Editing instruction describing what changes to make
  - image_paths (string[], required): Array of local file paths or URLs to source images (1-14 images)
  - output_path (string, required): File path to save the result. Can be a directory (filename will be auto-generated with timestamp) or a full file path
  - model (string, optional): "gemini-3.1-flash-image" (default), "gemini-3.1-flash-lite-image", or "gemini-3-pro-image"
  - aspect_ratio (string, optional): Output aspect ratio. "auto" (default) preserves the original ratio
  - resolution (string, optional): Output quality - "0.5K", "1K", "2K", or "4K". Default: "1K"
  - output_format (string, optional): Output format - only "jpeg" is supported. Default: "jpeg"
  - num_images (number, optional): Number of variations to generate (1-4). Default: 1
  - temperature (number, optional): Creativity level 0.0-2.0. Default: 1.0

Returns:
  {
    "success": boolean,
    "images": [
      {
        "path": string,
        "format": string
      }
    ],
    "description": string (model's description),
    "error": string (if failed)
  }

Examples:
  - Style transfer: image_paths=["photo.jpg", "vangogh.jpg"], prompt="Apply the artistic style of the second image to the first"
  - Background removal: image_paths=["portrait.jpg"], prompt="Remove the background and replace with pure white"
  - Colorization: image_paths=["old_photo_bw.jpg"], prompt="Colorize this black and white photo with realistic colors"
  - Multi-image composite: image_paths=["person.jpg", "beach.jpg"], prompt="Place the person from the first image on the beach from the second image"`;

/**
 * Register the edit_image tool with the MCP server
 */
export function registerEditImageTool(server: McpServer): void {
  server.registerTool(
    "nanobanana_edit_image",
    {
      title: "Edit Image with Nano Banana",
      description: TOOL_DESCRIPTION,
      inputSchema: EditImageInputSchema,
      outputSchema: EditImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Creates files when output_path provided
        destructiveHint: false, // Doesn't delete existing data
        idempotentHint: false, // Same inputs can produce different results
        openWorldHint: true, // Interacts with external Google API
      },
    },
    async (params) => {
      try {
        // Apply defaults for optional parameters (MCP does not auto-apply Zod defaults)
        const model = params.model ?? DEFAULTS.model;
        const aspectRatioParam = params.aspect_ratio ?? "auto";
        // "auto" -> omit aspect ratio so the model preserves the native ratio.
        const aspectRatio =
          aspectRatioParam === "auto" ? undefined : aspectRatioParam;
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

        // Validate model options before loading images / any API call (fail fast)
        validateGenerationConfig(config);

        // Load all input images
        const inputImages: InputImage[] = [];
        for (const imagePath of params.image_paths) {
          const image = await loadImage(imagePath);
          inputImages.push(image);
        }

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
            const response = await editImage(params.prompt, inputImages, config);
            collected.push(...response.images);
            if (response.description) descriptions.push(response.description);
          } catch (err) {
            if (collected.length === 0) throw err;
            break;
          }
        }

        const imagesToSave = collected.slice(0, requestedCount);

        // Process the generated images - save to files
        const outputImages: EditImageOutput["images"] = [];

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

        const output: EditImageOutput = {
          success: true,
          images: outputImages,
          description,
        };

        // Format response text
        const paths = outputImages.map((img) => img.path).join("\n  ");
        let textContent = `Successfully edited ${params.image_paths.length} image(s) and generated ${outputImages.length} result(s):\n  ${paths}`;
        if (outputImages.length < requestedCount) {
          textContent += `\n\nWarning: requested ${requestedCount} result(s) but only ${outputImages.length} were produced.`;
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
            : `Error: Unexpected error during image editing. ${error instanceof Error ? error.message : String(error)}`;

        const output: EditImageOutput = {
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
