/**
 * Edit Image Tool Implementation
 *
 * Edits existing images using text prompts with Nano Banana Pro (Gemini 3 Pro Image).
 * Supports style transfer, image modification, and multi-image composition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EditImageInputSchema,
  EditImageOutputSchema,
  type EditImageOutput,
} from "../schemas/edit.js";
import { editImage } from "../services/gemini-client.js";
import {
  resolveOutputPath,
  saveBase64Image,
  loadImage,
} from "../services/file-utils.js";
import { McpError, ErrorType, type InputImage } from "../types.js";
import { LIMITS, DEFAULTS, type AspectRatio, type OutputFormat } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit images using text prompts with Nano Banana Pro (Google's Gemini 3 Pro Image model).

This tool modifies existing images based on your instructions. It supports:
- Basic editing: "Remove the background", "Make it brighter", "Crop to focus on the face"
- Style transfer: Apply artistic styles from reference images
- Character consistency: Maintain character identity across different poses/scenes
- Multi-image composition: Combine up to 14 images into new compositions
- Colorization: Convert black & white photos to color
- Object manipulation: Move, add, or remove objects

Args:
  - prompt (string, required): Editing instruction describing what changes to make
  - image_paths (string[], required): Array of local file paths or URLs to source images (1-14 images)
  - output_path (string, required): File path to save the result. Can be a directory (filename will be auto-generated with timestamp) or a full file path
  - aspect_ratio (string, optional): Output aspect ratio. "auto" preserves original. Default: "auto"
  - resolution (string, optional): Output quality - "1K", "2K", or "4K". Default: "1K"
  - output_format (string, optional): Output format - "png", "jpeg", or "webp". Default: "png"
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
      title: "Edit Image with Nano Banana Pro",
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
        // Validate number of input images
        if (params.image_paths.length > LIMITS.maxInputImages) {
          throw new McpError(
            ErrorType.TOO_MANY_IMAGES,
            `Error: Maximum ${LIMITS.maxInputImages} input images allowed. You provided ${params.image_paths.length}.`
          );
        }

        // Apply defaults for optional parameters
        const aspectRatioParam = params.aspect_ratio ?? "auto";
        const resolution = params.resolution ?? DEFAULTS.resolution;
        const temperature = params.temperature ?? DEFAULTS.temperature;
        const numImages = params.num_images ?? DEFAULTS.numImages;
        const outputFormat = (params.output_format ?? DEFAULTS.outputFormat) as OutputFormat;

        // Load all input images
        const inputImages: InputImage[] = [];
        for (const imagePath of params.image_paths) {
          const image = await loadImage(imagePath);
          inputImages.push(image);
        }

        // Determine aspect ratio (handle 'auto' case)
        const aspectRatio: AspectRatio =
          aspectRatioParam === "auto"
            ? "1:1" // Default when auto - the API will use image's native ratio
            : (aspectRatioParam as AspectRatio);

        // Call the Gemini API to edit images
        const response = await editImage(params.prompt, inputImages, {
          aspectRatio,
          resolution,
          temperature,
          numImages,
        });

        // Process the generated images - save to files
        const outputImages: EditImageOutput["images"] = [];

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

        const output: EditImageOutput = {
          success: true,
          images: outputImages,
          description: response.description,
        };

        // Format response text
        const paths = outputImages.map((img) => img.path).join("\n  ");
        let textContent = `Successfully edited ${params.image_paths.length} image(s) and generated ${outputImages.length} result(s):\n  ${paths}`;
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
