/**
 * Generate Image Tool Implementation
 *
 * Generates images from text prompts using either Google's Nano Banana models
 * (Gemini Interactions API) or OpenAI's GPT Image 2.5 models, selected with
 * the `model` parameter.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GenerateImageInputSchema } from "../schemas/generate.js";
import { ImageToolOutputSchema } from "../schemas/output.js";
import { generateImage, validateGenerationConfig, requireProviderKey } from "../providers/index.js";
import { inferOutputFormatFromPath } from "../services/file-utils.js";
import { acquireImageOperation, throwIfImageCancelled } from "../services/image-operation.js";
import { resolveOutputDestination } from "../services/path-policy.js";
import type { GenerationConfig } from "../types.js";
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
const TOOL_DESCRIPTION = `Generate images from a text prompt with Google Nano Banana (Gemini) or OpenAI GPT Image 2.5 models and save them as files. Unsupported model/option combinations are rejected before any API call, naming the supported values; nothing is silently downgraded.

- aspect_ratio is a target: its field lists sizes per ratio; images[].aspect_error_pct is the drift. Resize or crop for an exact ratio.
- status: complete, partial or failed; partial/failed carry an issue with what happened and the next step. Nothing is retried automatically.
- SERVER_BUSY: one image call runs at a time; retry after it finishes. No request was sent.
- A model whose provider key is not configured fails at call time.

${MODEL_GUIDE}

Examples:
- Sticker: model="gpt-image-2.5-flare", transparent_background=true, output_path="~/stickers/logo.png"
- Poster with text: model="gpt-image-2.5-sunburst", quality="high", aspect_ratio="2:3"`;

/**
 * Register the generate_image tool with the MCP server
 */
export function registerGenerateImageTool(server: McpServer): void {
  server.registerTool(
    "hokuz_generate_image",
    {
      title: "Generate Image",
      description: TOOL_DESCRIPTION,
      inputSchema: GenerateImageInputSchema,
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
        const aspectRatio = params.aspect_ratio ?? DEFAULTS.aspectRatio;
        const resolution = params.resolution ?? DEFAULTS.resolution;
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
          resolution,
          outputFormat,
          temperature: params.temperature,
          quality: params.quality,
          transparentBackground: params.transparent_background,
        };

        // Validate model options before any API call (fail fast, no downgrades)
        validateGenerationConfig(config);
        throwIfImageCancelled(signal);
        requireProviderKey(model);
        release = acquireImageOperation();
        await resolveOutputDestination(params.output_path);

        pipelineStarted = true;
        return await runImageTool({
          config,
          outputPath: params.output_path,
          requestedCount: params.num_images ?? DEFAULTS.numImages,
          includePreview: params.include_preview ?? false,
          signal,
          produce: () => generateImage(params.prompt, config, signal),
        });
      } catch (error) {
        return imageToolError(error, !pipelineStarted);
      } finally {
        release?.();
      }
    }
  );
}
