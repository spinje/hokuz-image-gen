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
const TOOL_DESCRIPTION = `Edit images with text instructions. Two providers behind one tool: Google's Nano Banana (Gemini) models and OpenAI's GPT Image 2.5 models. Pick with \`model\`. Handles basic edits ("remove the background"), style transfer, character consistency, colorization, object manipulation and multi-image composition.

Unsupported combinations (model x resolution / aspect ratio / output format / provider-only option) are rejected before any image is loaded or any API call is made with an error naming the supported values. No silent downgrades.

Models (approximate time and cost for one 1K image; verify at https://ai.google.dev/gemini-api/docs/pricing and https://developers.openai.com/api/docs/pricing):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~$0.034, 1K only. Quick edits, high-volume batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~$0.045-$0.15 (0.5K-4K), extreme aspect ratios. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~$0.13 (1K/2K) to ~$0.24 (4K). Photorealistic and high-fidelity edits.
- gpt-image-2.5-flare (OpenAI): fast; cost set by \`quality\` (medium ~$0.013 at 14s; high ~$0.05 at 18s; max ~$0.21 at 46s). Quick edits with strong text rendering.
- gpt-image-2.5-sunburst (OpenAI): same prices, roughly 1.5-2x slower (high ~30s, max ~85s). The choice when approved details (faces, logos, layout) must survive the edit.
Reference images cost about $0.01 each on OpenAI models (~1000 input tokens per 1K image) versus a fraction of a cent on Gemini; for compositions with 4+ reference images prefer gemini-3.1-flash-image.
OpenAI models: 1K or 2K only (about 1 and 4 megapixels; exact size is derived from aspect_ratio and returned), the ten base aspect ratios, jpeg/png/webp output, \`quality\` ladder, optional transparent background. Gemini models: jpeg only, \`temperature\`. Higher resolution and quality cost more and take longer. num_images > 1 makes that many separate requests: time and cost scale linearly, and OpenAI tier-1 accounts allow 5 images per minute.

Args:
  - prompt (string, required): Editing instruction describing what changes to make
  - image_paths (string[], required): 1-14 images (Gemini, 7 MB each) or 1-16 (OpenAI, 50 MB each, jpeg/png/webp only), local paths or URLs, in prompt order ("first image"/"second image")
  - output_path (string, required): File path or directory (timestamped name) to save to. Extension is replaced to match output_format
  - model (string, optional): see above. Default: "gemini-3.1-flash-image"
  - aspect_ratio (string, optional): "auto" (default) keeps the input's ratio; on OpenAI models "auto" lets the provider choose the output size, so set a ratio to control it
  - resolution (string, optional): "0.5K", "1K", "2K", "4K" per model. Default: "1K". On OpenAI models it needs an explicit aspect_ratio: "auto" plus a resolution is rejected
  - output_format (string, optional): "jpeg" (all models), "png"/"webp" (OpenAI only). Default: "jpeg"
  - quality (string, optional, OpenAI only): "low", "medium", "high", "xhigh", "max". Default: "medium"
  - transparent_background (boolean, optional, OpenAI only): requires png or webp
  - temperature (number, optional, Gemini only): 0.0-2.0. Default: 1.0
  - num_images (number, optional): 1-4. Default: 1

Returns: { success, images: [{ path, format, width?, height? }], description?, usage? { input_tokens, output_tokens, estimated_cost_usd } (OpenAI only, estimated from token counts), warning? (fewer images than requested, with the reason), error? }

Examples:
  - Style transfer: image_paths=["photo.jpg", "vangogh.jpg"], prompt="Apply the artistic style of the second image to the first"
  - Background removal: image_paths=["portrait.jpg"], prompt="Remove the background and replace with pure white"
  - Faithful edit: model="gpt-image-2.5-sunburst", quality="high", prompt="Change the jacket to navy, keep everything else identical"
  - Multi-image composite: image_paths=["person.jpg", "beach.jpg"], prompt="Place the person from the first image on the beach from the second image"`;

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
        destructiveHint: false, // Doesn't delete existing data
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
        const outputFormat = params.output_format ?? DEFAULTS.outputFormat;

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
