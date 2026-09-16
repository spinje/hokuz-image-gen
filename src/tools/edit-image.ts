/**
 * Edit Image Tool Implementation
 *
 * Edits existing images using text prompts with either Google's Nano Banana
 * models (Gemini Interactions API) or OpenAI's GPT Image 2.5 models, selected
 * with the `model` parameter. Supports style transfer, image modification, and
 * multi-image composition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EditImageInputSchema } from "../schemas/edit.js";
import { ImageToolOutputSchema } from "../schemas/output.js";
import { editImage, validateGenerationConfig } from "../providers/index.js";
import {
  inferOutputFormatFromPath,
  loadInputImage,
} from "../services/file-utils.js";
import type { GenerationConfig, InputImage } from "../types.js";
import {
  IMAGE_TOOL_ANNOTATIONS,
  MODEL_GUIDE,
  imageToolError,
  runImageTool,
} from "./image-tool.js";
import { DEFAULTS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit images with text instructions using Google's Nano Banana (Gemini) or OpenAI's GPT Image 2.5 models; pick with \`model\`. Basic edits ("remove the background"), style transfer, character consistency, colorization, object manipulation and multi-image composition. Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any image is loaded and before any API call, as an error result naming the supported values; nothing is silently downgraded.

${MODEL_GUIDE}
OpenAI models take 1K (~1 megapixel) or 2K (~4 megapixels, about twice the cost) at the ten base ratios; the exact pixel size is derived from the ratio. Every result reports each image's pixel size and an estimated cost (Google's per-image price on Gemini, token-based on OpenAI). Gemini models produce jpeg only; OpenAI models produce jpeg, png or webp and can render a transparent background (png/webp only). A model whose provider key is not configured on the server fails at call time with an error naming the variable.

Rules the schema cannot express:
- image_paths: local paths or URLs, in the order the prompt refers to them ("first image"). Gemini models: up to 14 images, 7 MB each, jpeg/png/webp/gif/heic/heif. OpenAI models: up to 16, 50 MB each, jpeg/png/webp only. A reference image costs ~$0.01 on OpenAI and a fraction of a cent on Gemini, so prefer gemini-3.1-flash-image for compositions with 4+ references. Each image is checked for type and size before any API call; the first bad one fails the whole call.
- aspect_ratio "auto" (the default): Gemini models keep the input's framing and composition and re-render it at resolution (1K unless set), so set 2K or 4K to keep the detail of a large input. OpenAI models re-render at a size of their own choosing near the input's ratio (roughly 1-2 megapixels), and resolution must then be omitted (an explicit resolution with auto is rejected); set a ratio to control the size, which recomposes the image. Only Gemini keeps the original framing.
- There is no mask or inpainting: describe the region to change in the prompt and say what must stay unchanged.
- output_path, provider-only options and num_images behave as in hokuz_generate_image.

Examples:
- Faithful edit: model="gemini-3-pro-image", prompt="Change the jacket to navy; keep everything else identical"
- Precise text/layout edit: model="gpt-image-2.5-sunburst", quality="high", aspect_ratio="2:3"
- Style transfer: image_paths=["photo.jpg", "vangogh.jpg"], prompt="Apply the style of the second image to the first"
- Composition: model="gemini-3.1-flash-image", image_paths=[five product photos], prompt="Arrange the products in one catalogue layout on white"`;

/**
 * Register the edit_image tool with the MCP server
 */
export function registerEditImageTool(server: McpServer): void {
  server.registerTool(
    "hokuz_edit_image",
    {
      title: "Edit Image",
      description: TOOL_DESCRIPTION,
      inputSchema: EditImageInputSchema,
      outputSchema: ImageToolOutputSchema,
      annotations: IMAGE_TOOL_ANNOTATIONS,
    },
    async (params) => {
      try {
        // The SDK has already applied the schema's .default() values; these fallbacks
        // are defence in depth only. Optionality is decided by .default() in the schema.
        const model = params.model ?? DEFAULTS.model;
        const aspectRatioParam = params.aspect_ratio ?? "auto";
        // "auto" -> omit aspect ratio so the model preserves the native ratio.
        const aspectRatio =
          aspectRatioParam === "auto" ? undefined : aspectRatioParam;
        // Explicit output_format wins; otherwise the output_path's extension
        // picks the format, so 'logo.png' on a Gemini model is rejected below
        // rather than saved as a JPEG named logo.jpg.
        const outputFormat =
          params.output_format ??
          inferOutputFormatFromPath(params.output_path) ??
          DEFAULTS.outputFormat;

        // Provider-specific options carry no schema default and are passed
        // through as given: the provider that owns the option applies its own
        // default, so an option the caller did not ask for stays undefined.
        const config: GenerationConfig = {
          model,
          aspectRatio,
          // No schema default: "auto" plus an explicit resolution is rejected,
          // which the handler could not tell from a filled-in default.
          resolution: params.resolution,
          outputFormat,
          temperature: params.temperature,
          quality: params.quality,
          transparentBackground: params.transparent_background,
        };

        // Validate model options before loading images / any API call (fail fast)
        validateGenerationConfig(config, {
          inputImageCount: params.image_paths.length,
        });

        // Load the input images in order; the loader checks each one's type
        // and size against the model before reading it.
        const inputImages: InputImage[] = [];
        for (const imagePath of params.image_paths) {
          inputImages.push(await loadInputImage(imagePath, model));
        }

        return await runImageTool({
          outputFormat,
          outputPath: params.output_path,
          requestedCount: params.num_images ?? DEFAULTS.numImages,
          produce: () => editImage(params.prompt, inputImages, config),
          summary: (n) => `Successfully edited ${params.image_paths.length} image(s) and generated ${n} result(s):`,
        });
      } catch (error) {
        return imageToolError(error, "editing");
      }
    }
  );
}
