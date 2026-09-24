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
import { ErrorType, ToolError, type GenerationConfig, type InputImage } from "../types.js";
import {
  IMAGE_TOOL_ANNOTATIONS,
  MODEL_GUIDE,
  imageToolError,
  runImageTool,
} from "./image-tool.js";
import { DEFAULTS, IMAGE_MODEL_CAPABILITIES, LIMITS, nearestAspectRatio } from "../constants.js";
import { displayedPixelSize, type PixelSize } from "../services/image-size.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit or combine images from a text instruction with Gemini (Nano Banana) or OpenAI GPT Image 2.5 models, saving a file: style transfer, object changes, colorization, composition. Unsupported model/option combinations are rejected before inputs load or any API call, naming the supported values; nothing is silently downgraded.

- Edits are generative, not pixel-identical: details beyond the request can change. There is no mask: name the region to change and what must stay, then inspect the result before reporting what changed.
- "Remove the background" only replaces it; a transparent result needs an OpenAI model, transparent_background=true and png/webp.
- aspect_ratio is a target: its field lists sizes per ratio; images[].aspect_error_pct is the drift. Resize or crop for an exact ratio.
- status: complete, partial or failed; partial/failed carry an issue with what happened and the next step. Nothing is retried automatically.
- SERVER_BUSY: one image call runs at a time; retry after it finishes. No input loaded, no request sent.
- A model whose provider key is not configured fails at call time.

${MODEL_GUIDE}`;

/**
 * The displayed size of the first input, which match_input shapes the output
 * to. Read from header bytes already in memory; no provider request has been
 * made when this throws.
 */
function firstInputSize(image: InputImage, source: string): PixelSize {
  const size = displayedPixelSize(Buffer.from(image.data, "base64"));
  if (size) return size;
  const heif = image.mimeType === "image/heic" || image.mimeType === "image/heif";
  throw new ToolError(
    ErrorType.INVALID_IMAGE_PATH,
    heif
      ? `aspect_ratio 'match_input' cannot read the pixel size of the HEIC/HEIF first image '${source}'.`
      : `aspect_ratio 'match_input' could not read the pixel size of the first image '${source}': its header is not a readable JPEG, PNG, WebP or GIF.`,
    "Pass an explicit aspect_ratio, or convert the first image to JPEG/PNG/WebP."
  );
}

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
        const matchInput = aspectRatioParam === "match_input";
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
        let config: GenerationConfig = {
          model,
          // "auto" -> undefined: the provider decides the ratio/size.
          // "match_input" is resolved once the first image is loaded.
          aspectRatio: aspectRatioParam === "auto" || matchInput ? undefined : aspectRatioParam,
          // No schema default: OpenAI rejects "auto" plus an explicit resolution,
          // which the handler could not tell from a filled-in default.
          resolution: params.resolution,
          outputFormat,
          temperature: params.temperature,
          quality: params.quality,
          transparentBackground: params.transparent_background,
        };

        // Validate model options before loading images / any API call (fail
        // fast). match_input will resolve to one of the model's own ratios, so
        // any of them stands in for it here: it is an explicit ratio as far as
        // the other rules (OpenAI's resolution rule) are concerned.
        validateGenerationConfig(
          matchInput ? { ...config, aspectRatio: IMAGE_MODEL_CAPABILITIES[model].aspectRatios[0] } : config,
          { inputImageCount: params.image_paths.length }
        );
        throwIfImageCancelled(signal);
        requireProviderKey(model);
        release = acquireImageOperation();
        await resolveOutputDestination(params.output_path);

        // Load the input images in order; the loader checks each one's type
        // and size against the model before reading it.
        const inputImages: InputImage[] = [];
        let remainingInputBytes = LIMITS.maxTotalInputImageBytes;
        let matchedInput: PixelSize | undefined;
        for (const imagePath of params.image_paths) {
          const image = await loadInputImage(imagePath, model, signal, remainingInputBytes);
          remainingInputBytes -= Buffer.byteLength(image.data, "base64");
          inputImages.push(image);
          if (matchInput && inputImages.length === 1) {
            // Before the remaining inputs load: an unreadable size fails fast.
            matchedInput = firstInputSize(image, imagePath);
            config = { ...config, aspectRatio: nearestAspectRatio(model, matchedInput.width, matchedInput.height) };
            validateGenerationConfig(config, { inputImageCount: params.image_paths.length });
          }
        }

        pipelineStarted = true;
        return await runImageTool({
          config,
          matchedInput,
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
