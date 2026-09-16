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
  inferOutputFormatFromPath,
  resolveOutputPath,
  saveBase64Image,
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
const TOOL_DESCRIPTION = `Generate images from text prompts with Google's Nano Banana (Gemini) or OpenAI's GPT Image 2.5 models; pick with \`model\`. Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any API call as an error result naming the supported values; nothing is silently downgraded.

Models (approximate time and cost for one 1K image):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~$0.034, 1K only. Cheapest Gemini model; drafts and batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~$0.045-$0.15 by resolution (0.5K-4K); the only model with 1:4, 4:1, 1:8, 8:1. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~$0.13 (1K/2K) to ~$0.24 (4K). Photorealism, hero shots, factual content.
- gpt-image-2.5-flare (OpenAI): cost and time follow \`quality\`: low ~$0.006/10s, medium ~$0.013/14s, high ~$0.05/18s, xhigh ~$0.09/27s, max ~$0.21/46s. The cheapest image overall is flare at low. Strong text rendering.
- gpt-image-2.5-sunburst (OpenAI): same prices, about 1.5-2x slower (high ~30s, max ~85s). Best for text-heavy posters, branding and precise composition.
OpenAI models take 1K (~1 megapixel) or 2K (~4 megapixels, about twice the cost) at the ten base ratios; the exact pixel size is derived from the ratio and reported in the result. Gemini models produce jpeg only and report no usage; OpenAI models produce jpeg, png or webp, can render a transparent background (png/webp only), and report token usage with an estimated cost.

Rules the schema cannot express:
- output_path: a trailing slash or an existing directory means a timestamped file inside it; otherwise it is the file to write. Parent directories are created. An existing file is never overwritten: -2, -3, ... is appended. When output_format is omitted the path's extension (.jpg/.png/.webp) selects it, else jpeg; the saved extension always matches the format.
- quality and transparent_background are OpenAI-only; temperature is Gemini-only. An explicit value on the other provider is rejected, not ignored. Omit them and the provider applies its default (medium / 1.0). transparent_background: false is accepted everywhere.
- num_images makes that many separate requests, so time and cost scale linearly; if a later request fails you get the images so far plus a \`warning\` naming the reason. OpenAI tier-1 accounts allow 5 images per minute.

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
      outputSchema: GenerateImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Always writes the result to output_path
        destructiveHint: false, // Never deletes or overwrites an existing file
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

        // num_images is implemented via repeated independent requests, each
        // asking for one image. Stop once we have enough.
        const collected: GeneratedImage[] = [];
        const descriptions: string[] = [];
        const usages: UsageReport[] = [];
        let successfulRequests = 0;
        let failureReason: string | undefined;
        for (
          let attempt = 0;
          collected.length < requestedCount && attempt < requestedCount;
          attempt++
        ) {
          try {
            const response = await generateImage(params.prompt, config);
            collected.push(...response.images);
            successfulRequests++;
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
          // Say so when the totals cover only some of the requests, rather
          // than letting them read as the cost of the whole call.
          const scope =
            usages.length < successfulRequests
              ? ` (reported for ${usages.length} of ${successfulRequests} requests)`
              : "";
          textContent += `\n\nUsage${scope}: ${usage.inputTokens} input + ${usage.outputTokens} output tokens, estimated cost $${usage.estimatedCostUsd.toFixed(4)}`;
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
