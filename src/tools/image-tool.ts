/**
 * The pipeline both image tools run once their arguments are mapped and
 * validated: the num_images loop, saving, usage, the warning, the response
 * text and the uniform failure result.
 *
 * A tool file keeps only what is genuinely its own — the TOOL_DESCRIPTION, its
 * input schema, and the param -> GenerationConfig mapping.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GEMINI_PRICE_PER_IMAGE_USD,
  type ImageModel,
  type OutputFormat,
  type Resolution,
} from "../constants.js";
import type { ImageToolOutput } from "../schemas/output.js";
import { resolveOutputPath, saveBase64Image } from "../services/file-utils.js";
import {
  McpError,
  type GeneratedImage,
  type ImageResponse,
  type UsageReport,
} from "../types.js";

/**
 * A Gemini per-image price as the guide quotes it ("$0.034", "$0.24"). Every
 * price it asks for exists: `constants.test.ts` pins one for every resolution a
 * Gemini model supports, so the throw is a build-time tripwire, not a runtime path.
 */
function usd(model: ImageModel, resolution: Resolution): string {
  const price = GEMINI_PRICE_PER_IMAGE_USD[model]?.[resolution];
  if (price === undefined) {
    throw new Error(`No Gemini price for ${model} at ${resolution}`);
  }
  return `$${price.toFixed(3).replace(/0$/, "")}`;
}

/**
 * The model guidance both TOOL_DESCRIPTIONs embed verbatim. The Gemini figures
 * come from the price table the server bills its estimates against; the OpenAI
 * ones are hand-maintained benchmark estimates with nothing to derive them from.
 */
export const MODEL_GUIDE = `Models (approximate time and cost for one 1K image):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~${usd("gemini-3.1-flash-lite-image", "1K")}, 1K only. Cheapest Gemini model; drafts and batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~${usd("gemini-3.1-flash-image", "0.5K")} (0.5K) / ${usd("gemini-3.1-flash-image", "1K")} (1K) / ${usd("gemini-3.1-flash-image", "2K")} (2K) / ${usd("gemini-3.1-flash-image", "4K")} (4K); the only model with 1:4, 4:1, 1:8, 8:1. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~${usd("gemini-3-pro-image", "1K")} (1K/2K) to ~${usd("gemini-3-pro-image", "4K")} (4K). Photorealism, hero shots, factual content.
- gpt-image-2.5-flare (OpenAI): cost and time follow \`quality\`: low ~$0.006/10s, medium ~$0.013/14s, high ~$0.05/18s, xhigh ~$0.09/27s, max ~$0.21/46s. The cheapest image overall is flare at low. Single subjects and short text.
- gpt-image-2.5-sunburst (OpenAI): same prices, about 1.5-2x slower (high ~30s, max ~85s). Multi-element text layouts, branding, and edits where precision matters.`;

/** Annotations shared by both tools (same file-writing, never-overwriting behaviour). */
export const IMAGE_TOOL_ANNOTATIONS = {
  readOnlyHint: false, // Always writes the result to output_path
  destructiveHint: false, // Never deletes or overwrites an existing file
  idempotentHint: false, // The same arguments produce a different image
  openWorldHint: true, // Interacts with an external provider API
} as const;

export interface ImageToolRun {
  /** Decides the saved file's extension and the format reported for it. */
  outputFormat: OutputFormat;
  outputPath: string;
  requestedCount: number;
  /**
   * One provider request. The pipeline calls it up to requestedCount times and
   * relies on it to throw when it produced no image: a resolved response with
   * empty `images` would count as a successful, billed request.
   */
  produce: () => Promise<ImageResponse>;
  /** First line of the text reply, e.g. "Successfully generated 2 image(s):". */
  summary: (savedCount: number) => string;
}

/**
 * Add up the per-request usage reports of one tool call (num_images makes one
 * request per image). Undefined when no request reported usage.
 */
function sumUsage(usages: UsageReport[]): UsageReport | undefined {
  if (usages.length === 0) return undefined;

  return usages.reduce((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    estimatedCostUsd: total.estimatedCostUsd + usage.estimatedCostUsd,
  }));
}

/** The num_images loop, saving, usage, warning, text and structured output. */
export async function runImageTool({
  outputFormat,
  outputPath,
  requestedCount,
  produce,
  summary,
}: ImageToolRun): Promise<CallToolResult> {
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
      const response = await produce();
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
  const outputImages: ImageToolOutput["images"] = [];

  for (let i = 0; i < imagesToSave.length; i++) {
    const image = imagesToSave[i];
    const filePath = await resolveOutputPath(outputPath, outputFormat, i);
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

  const output: ImageToolOutput = {
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
  let textContent = `${summary(outputImages.length)}\n  ${paths}`;
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
}

/** The uniform failure result. `activity` is "generation" or "editing". */
export function imageToolError(
  error: unknown,
  activity: string
): CallToolResult {
  const errorMessage =
    error instanceof McpError
      ? error.message
      : `Error: Unexpected error during image ${activity}. ${error instanceof Error ? error.message : String(error)}`;

  const output: ImageToolOutput = {
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
