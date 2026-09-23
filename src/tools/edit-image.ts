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
import { editImage, validateGenerationConfig, requireProviderKey } from "../providers/index.js";
import { acquireImageOperation, throwIfImageCancelled } from "../services/image-operation.js";
import { resolveOutputDestination } from "../services/path-policy.js";
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
import { DEFAULTS, LIMITS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit images with text instructions using Google's Nano Banana (Gemini) or OpenAI's GPT Image 2.5 models; pick with \`model\`. Basic edits ("remove the background"), style transfer, character consistency, colorization, object manipulation and multi-image composition. Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any image is loaded and before any API call, as an error result naming the supported values; nothing is silently downgraded.

${MODEL_GUIDE}

Rules the schema cannot express:
- Only one image call runs at a time per server process. SERVER_BUSY means wait for the active call to finish before retrying; no inputs were loaded or provider request started for the rejected call.
- include_preview is optional and off by default. When true, results may include a reduced JPEG preview; nonopaque images are shown on white (left) and navy (right). The saved original is unchanged. Preview alpha measurements describe original pixels, not whether the image is a clean cutout. If preview processing is unavailable or exceeds its bounds, the image call still succeeds with a preview_warning; inspect the saved file instead of regenerating it. Clients must support MCP image content to display previews.
- image_paths: local paths or public HTTP(S) URLs (private destinations are rejected, including redirects), in the order the prompt refers to them ("first image"). Gemini models: up to 14 images, 7 MB each, jpeg/png/webp/gif/heic/heif. OpenAI models: up to 16, 50 MB each, jpeg/png/webp only. A reference image costs ~$0.01 on OpenAI and a fraction of a cent on Gemini, so prefer gemini-3.1-flash-image for compositions with 4+ references. All references combined must fit the local ${LIMITS.maxTotalInputImageBytes / (1024 * 1024)} MiB input budget. Each image is checked for type and size before any API call; the first bad one fails the whole call.
- aspect_ratio "auto" (the default): Gemini omits the ratio from the request and applies resolution (1K unless set). OpenAI lets the provider choose the output size; resolution must be omitted (an explicit resolution with auto is rejected). Set an explicit ratio to request a target shape. Generative edits on either provider can change composition and details; auto does not guarantee original framing or pixel-identical preservation. Inspect the saved result for changes beyond the requested edit.
- There is no mask or inpainting: describe the region to change in the prompt and say what must stay unchanged. "Remove the background" works on any model but only replaces it; a genuinely transparent result needs an OpenAI model with transparent_background and png or webp.
- output_path, provider-only options and num_images behave as in hokuz_generate_image; in particular a .png or .webp output_path selects that format and therefore needs an OpenAI model. Results report status complete, partial, or failed; partial/failed results include an issue with what happened and what to do next. Generation requests are never automatically retried. Keep saved results and follow the issue advice before requesting missing images; an interrupted request may still incur a charge.

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
    async (params, { signal }) => {
      let release: (() => void) | undefined;
      let pipelineStarted = false;
      try {
        // The SDK has already applied the schema's .default() values; these fallbacks
        // are defence in depth only. Optionality is decided by .default() in the schema.
        const model = params.model ?? DEFAULTS.model;
        const aspectRatioParam = params.aspect_ratio ?? "auto";
        // "auto" -> let the provider decide the ratio/size.
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
          // No schema default: OpenAI rejects "auto" plus an explicit resolution,
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
        throwIfImageCancelled(signal);
        requireProviderKey(model);
        release = acquireImageOperation();
        await resolveOutputDestination(params.output_path);

        // Load the input images in order; the loader checks each one's type
        // and size against the model before reading it.
        const inputImages: InputImage[] = [];
        let remainingInputBytes = LIMITS.maxTotalInputImageBytes;
        for (const imagePath of params.image_paths) {
          const image = await loadInputImage(imagePath, model, signal, remainingInputBytes);
          remainingInputBytes -= Buffer.byteLength(image.data, "base64");
          inputImages.push(image);
        }

        pipelineStarted = true;
        return await runImageTool({
          outputFormat,
          outputPath: params.output_path,
          requestedCount: params.num_images ?? DEFAULTS.numImages,
          includePreview: params.include_preview ?? false,
          signal,
          produce: () => editImage(params.prompt, inputImages, config, signal),
        });
      } catch (error) {
        return imageToolError(error, !pipelineStarted);
      } finally {
        release?.();
      }
    }
  );
}
