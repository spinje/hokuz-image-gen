/**
 * Generate Image Tool Implementation
 *
 * Generates images from text prompts using either Google's Nano Banana models
 * (Gemini Interactions API) or OpenAI's GPT Image 2.5 models, selected with
 * the `model` parameter.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GenerateImageInputSchema,
  GenerateImageOutputSchema,
  type GenerateImageOutput,
} from "../schemas/generate.js";
import { generateImage, validateGenerationConfig } from "../providers/index.js";
import {
  resolveOutputPath,
  saveBase64Image,
  resolveRequestedOutputFormat,
} from "../services/file-utils.js";
import {
  McpError,
  sumUsage,
  type GeneratedImage,
  type GenerationConfig,
  type UsageReport,
} from "../types.js";
import { DEFAULTS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Generate images from text prompts. Two providers behind one tool: Google's Nano Banana (Gemini) models and OpenAI's GPT Image 2.5 models. Pick with \`model\`.

Unsupported combinations (model x resolution / aspect ratio / provider-only option) are rejected before any API call with an error naming the supported values. No silent downgrades.

Models (approximate time and cost for one 1K image; verify at https://ai.google.dev/gemini-api/docs/pricing and https://developers.openai.com/api/docs/pricing):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~$0.034, 1K only. Drafts, thumbnails, batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~$0.045-$0.15 (0.5K-4K), extreme aspect ratios. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~$0.13 (1K/2K) to ~$0.24 (4K). Photorealism, hero shots, factual/grounded content.
- gpt-image-2.5-flare (OpenAI): fast; cost set by \`quality\` (medium ~$0.013 at 14s; high ~$0.05 at 18s; max ~$0.21 at 46s). Strong text rendering and prompt adherence.
- gpt-image-2.5-sunburst (OpenAI): same prices, roughly 1.5-2x slower (high ~30s, max ~85s). Best for text-heavy posters, branding and precise composition; prefer flare for plain generation.
OpenAI models: 1K or 2K only (about 1 and 4 megapixels; exact size is derived from aspect_ratio and returned), the ten base aspect ratios, \`quality\` ladder. Gemini models: \`temperature\`. Every model outputs jpeg. Higher resolution and quality cost more and take longer. num_images > 1 makes that many separate requests: time and cost scale linearly, and OpenAI tier-1 accounts allow 5 images per minute.

Args:
  - prompt (string, required): Detailed description of the image
  - output_path (string, required): File path or directory (timestamped name) to save to. Extension is replaced to match output_format
  - model (string, optional): see above. Default: "gemini-3.1-flash-image"
  - aspect_ratio (string, optional): Default: "1:1". Extreme ratios (1:4, 4:1, 1:8, 8:1) are flash-only
  - resolution (string, optional): "0.5K", "1K", "2K", "4K" per model. Default: "1K"
  - output_format (string, optional): "jpeg", the only format produced. Default: "jpeg"
  - quality (string, optional, OpenAI only): "low", "medium", "high", "xhigh", "max". Default: "medium"
  - temperature (number, optional, Gemini only): 0.0-2.0. Default: 1.0
  - num_images (number, optional): 1-4. Default: 1

Returns: { success, images: [{ path, format, width?, height? }], description?, usage? { input_tokens, output_tokens, estimated_cost_usd } (OpenAI only, estimated from token counts), warning? (fewer images than requested, with the reason), error? }

Examples:
  - Landscape: prompt="A serene mountain lake at sunset", aspect_ratio="16:9"
  - Cheap draft on OpenAI: model="gpt-image-2.5-flare", quality="low", output_path="~/images/"
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
      outputSchema: GenerateImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Always writes the result to output_path
        destructiveHint: false, // Doesn't delete existing data
        idempotentHint: false, // Same prompt produces different images
        openWorldHint: true, // Interacts with an external provider API
      },
    },
    async (params) => {
      try {
        // The SDK has already applied the schema's .default() values; these fallbacks
        // are defence in depth only. Optionality is decided by .default() in the schema.
        const model = params.model ?? DEFAULTS.model;
        const aspectRatio = params.aspect_ratio ?? DEFAULTS.aspectRatio;
        const resolution = params.resolution ?? DEFAULTS.resolution;
        const requestedCount = params.num_images ?? DEFAULTS.numImages;
        const outputFormat = resolveRequestedOutputFormat(
          params.output_path,
          params.output_format
        );

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
        };

        // Validate model options before any API call (fail fast, no downgrades)
        validateGenerationConfig(config);

        // num_images is implemented via repeated independent requests, each
        // asking for one image. Stop once we have enough.
        const collected: GeneratedImage[] = [];
        const descriptions: string[] = [];
        const usages: UsageReport[] = [];
        let failureReason: string | undefined;
        for (
          let attempt = 0;
          collected.length < requestedCount && attempt < requestedCount;
          attempt++
        ) {
          try {
            const response = await generateImage(params.prompt, config);
            collected.push(...response.images);
            if (response.description) descriptions.push(response.description);
            if (response.usage) usages.push(response.usage);
          } catch (err) {
            // If we have no images yet, surface the error. Otherwise keep what
            // we got and warn that fewer than requested were produced.
            if (collected.length === 0) throw err;
            failureReason = err instanceof Error ? err.message : String(err);
            break;
          }
        }

        const usage = sumUsage(usages);
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
            width: image.width,
            height: image.height,
          });
        }

        const description = descriptions.length
          ? Array.from(new Set(descriptions)).join("\n---\n")
          : undefined;

        const warning =
          outputImages.length < requestedCount
            ? `Requested ${requestedCount} image(s) but only ${outputImages.length} were produced.` +
              (failureReason ? ` The failed request reported: ${failureReason}` : "")
            : undefined;

        const output: GenerateImageOutput = {
          success: true,
          images: outputImages,
          description,
          usage: usage && {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            estimated_cost_usd: usage.estimatedCostUsd,
          },
          warning,
        };

        // Format response text
        const paths = outputImages
          .map((img) =>
            img.width && img.height
              ? `${img.path} (${img.width}x${img.height})`
              : img.path
          )
          .join("\n  ");
        let textContent = `Successfully generated ${outputImages.length} image(s):\n  ${paths}`;
        if (usage) {
          textContent += `\n\nUsage: ${usage.inputTokens} input + ${usage.outputTokens} output tokens, estimated cost $${usage.estimatedCostUsd.toFixed(4)}`;
        }
        if (warning) {
          textContent += `\n\nWarning: ${warning}`;
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
