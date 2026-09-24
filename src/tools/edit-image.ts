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
const TOOL_DESCRIPTION = `Edit or combine images from a text instruction with Gemini (Nano Banana) or OpenAI GPT Image 2.5 models, saving a file: style transfer, object changes, colorization, composition. Unsupported model/option combinations are rejected before inputs load or any API call, naming the supported values; nothing is silently downgraded.

- Edits are generative, not pixel-identical: details beyond the request can change. There is no mask: name the region to change and what must stay, then inspect the result before reporting what changed.
- "Remove the background" only replaces it; a transparent result needs an OpenAI model, transparent_background=true and png/webp.
- aspect_ratio is a target: check the returned width/height; the ratio can be off by a few percent (1:8 at 1K gives 352x2928).
- status: complete, partial or failed; partial/failed carry an issue with what happened and the next step. Nothing is retried automatically.
- SERVER_BUSY: one image call runs at a time; retry after it finishes. No input was loaded and no request sent.
- A model whose provider key is not configured fails at call time.

${MODEL_GUIDE}`;

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
          config,
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
