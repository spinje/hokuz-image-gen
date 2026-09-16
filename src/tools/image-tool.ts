/**
 * The pipeline both image tools run once their arguments are mapped and
 * validated: the num_images loop, saving, usage, the warning, the response
 * text and the uniform failure result.
 *
 * A tool file keeps only what is genuinely its own — the TOOL_DESCRIPTION, its
 * input schema, and the param -> GenerationConfig mapping.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OutputFormat } from "../constants.js";
import type { ImageToolOutput } from "../schemas/output.js";
import { resolveOutputPath, saveBase64Image } from "../services/file-utils.js";
import {
  McpError,
  type GeneratedImage,
  type ImageResponse,
  type UsageReport,
} from "../types.js";

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
