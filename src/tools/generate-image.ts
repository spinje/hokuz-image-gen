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
import { generateImage, validateGenerationConfig } from "../providers/index.js";
import { inferOutputFormatFromPath } from "../services/file-utils.js";
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
const TOOL_DESCRIPTION = `Generate images from text prompts with Google's Nano Banana (Gemini) or OpenAI's GPT Image 2.5 models; pick with \`model\`. Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any API call as an error result naming the supported values; nothing is silently downgraded.

${MODEL_GUIDE}

Rules the schema cannot express:
- output_path: a trailing slash or an existing directory means a timestamped file inside it; otherwise it is the file to write. Parent directories are created. An existing file is never overwritten: -2, -3, ... is appended. When output_format is omitted the path's extension (.jpg/.png/.webp) selects it, else jpeg; the saved extension always matches the format. A .png/.webp path therefore needs an OpenAI model; with a Gemini model use .jpg or a directory. The returned path is authoritative and differs from output_path when a suffix was needed.
- quality and transparent_background are OpenAI-only; temperature is Gemini-only. An explicit value on the other provider is rejected, not ignored. Omit them and the provider applies its default (medium / 1.0). transparent_background: false is accepted everywhere.
- num_images makes that many separate requests, one after another, so time and cost scale linearly and the whole call blocks until the last one returns (4 sunburst images at max quality is several minutes). If a later request fails you get the images so far, still as a success, plus a \`warning\` naming the reason; re-request only the shortfall. OpenAI tier-1 accounts allow 5 images per minute.

Examples:
- Draft: model="gpt-image-2.5-flare", quality="low", output_path="~/drafts/"
- Poster with text: model="gpt-image-2.5-sunburst", quality="high", aspect_ratio="2:3"
- Sticker: model="gpt-image-2.5-flare", transparent_background=true, output_path="~/stickers/logo.png"
- Hero shot: model="gemini-3-pro-image", aspect_ratio="16:9", resolution="2K"`;

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
    async (params) => {
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

        return await runImageTool({
          outputFormat,
          outputPath: params.output_path,
          requestedCount: params.num_images ?? DEFAULTS.numImages,
          produce: () => generateImage(params.prompt, config),
          summary: (n) => `Successfully generated ${n} image(s):`,
        });
      } catch (error) {
        return imageToolError(error, "generation");
      }
    }
  );
}
