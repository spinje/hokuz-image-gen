/**
 * Edit Image Tool Implementation
 *
 * Edits existing images using text prompts with either Google's Nano Banana
 * models (Gemini Interactions API) or OpenAI's GPT Image 2.5 models, selected
 * with the `model` parameter. Supports style transfer, image modification, and
 * multi-image composition.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EditImageInputSchema,
  EditImageOutputSchema,
  type EditImageOutput,
} from "../schemas/edit.js";
import { editImage, validateGenerationConfig } from "../providers/index.js";
import {
  inferOutputFormatFromPath,
  resolveOutputPath,
  saveBase64Image,
  loadInputImage,
} from "../services/file-utils.js";
import {
  McpError,
  sumUsage,
  type InputImage,
  type GeneratedImage,
  type GenerationConfig,
  type UsageReport,
} from "../types.js";
import { DEFAULTS } from "../constants.js";

/**
 * Tool description for LLM discoverability
 */
const TOOL_DESCRIPTION = `Edit images with text instructions using Google's Nano Banana (Gemini) or OpenAI's GPT Image 2.5 models; pick with \`model\`. Basic edits ("remove the background"), style transfer, character consistency, colorization, object manipulation and multi-image composition. Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any image is loaded and before any API call, as an error result naming the supported values; nothing is silently downgraded.

Models (approximate time and cost for one 1K image):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~$0.034, 1K only. Cheapest Gemini model; drafts and batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~$0.045-$0.15 by resolution (0.5K-4K); the only model with 1:4, 4:1, 1:8, 8:1. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~$0.13 (1K/2K) to ~$0.24 (4K). Photorealism, hero shots, factual content.
- gpt-image-2.5-flare (OpenAI): cost and time follow \`quality\`: low ~$0.006/10s, medium ~$0.013/14s, high ~$0.05/18s, xhigh ~$0.09/27s, max ~$0.21/46s. The cheapest image overall is flare at low. Strong text rendering.
- gpt-image-2.5-sunburst (OpenAI): same prices, about 1.5-2x slower (high ~30s, max ~85s). Best for text-heavy posters, branding and precise composition.
OpenAI models take 1K (~1 megapixel) or 2K (~4 megapixels, about twice the cost) at the ten base ratios; the exact pixel size is derived from the ratio and reported in the result. Gemini models produce jpeg only and report no usage; OpenAI models produce jpeg, png or webp, can render a transparent background (png/webp only), and report token usage with an estimated cost.

Rules the schema cannot express:
- image_paths: local paths or URLs, in the order the prompt refers to them ("first image"). Gemini models: up to 14 images, 7 MB each, jpeg/png/webp/gif/heic/heif. OpenAI models: up to 16, 50 MB each, jpeg/png/webp only. A reference image costs ~$0.01 on OpenAI and a fraction of a cent on Gemini, so prefer gemini-3.1-flash-image for compositions with 4+ references.
- aspect_ratio "auto" (the default, whether omitted or passed): Gemini models keep the input's exact framing and apply resolution (1K unless set). OpenAI models re-render at a size of their own choosing near the input's ratio, and resolution must then be omitted (an explicit resolution with auto is rejected); set a ratio to control the size, which recomposes the image. Only Gemini preserves the input framing pixel for pixel.
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
      outputSchema: EditImageOutputSchema,
      annotations: {
        readOnlyHint: false, // Always writes the result to output_path
        destructiveHint: false, // Never deletes or overwrites an existing file
        idempotentHint: false, // Same inputs can produce different results
        openWorldHint: true, // Interacts with an external provider API
      },
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
            const response = await editImage(params.prompt, inputImages, config);
            collected.push(...response.images);
            successfulRequests++;
            if (response.description) descriptions.push(response.description);
            if (response.usage) usages.push(response.usage);
          } catch (err) {
            if (collected.length === 0) throw err;
            failureReason = err instanceof Error ? err.message : String(err);
            break;
          }
        }

        const usage = sumUsage(usages);
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

        const output: EditImageOutput = {
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
        let textContent = `Successfully edited ${params.image_paths.length} image(s) and generated ${outputImages.length} result(s):\n  ${paths}`;
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
