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
  ErrorType,
  McpError,
  type GeneratedImage,
  type ImageResponse,
  type UsageReport,
} from "../types.js";

/**
 * A Gemini per-image price as the guide quotes it ("$0.034", "$0.24"). The
 * table is `Partial`, so a missing row is not a type error: the throw fires
 * while this module loads and the server refuses to start. `constants.test.ts`
 * pins a price for every resolution a Gemini model supports, so CI sees it first.
 */
function usd(model: ImageModel, resolution: Resolution): string {
  const price = GEMINI_PRICE_PER_IMAGE_USD[model]?.[resolution];
  if (price === undefined) {
    throw new Error(`No Gemini price for ${model} at ${resolution}`);
  }
  return `$${price.toFixed(3).replace(/0$/, "")}`;
}

/**
 * The model guidance both TOOL_DESCRIPTIONs embed verbatim: which model to pick,
 * and what every model does regardless of which tool is calling. The Gemini
 * figures come from the price table the server bills its estimates against; the
 * OpenAI ones are hand-maintained benchmark estimates with nothing to derive
 * them from. Anything that differs between the two tools stays in the tool file.
 */
export const MODEL_GUIDE = `Models (approximate time and cost for one 1K image):
- gemini-3.1-flash-lite-image (Nano Banana 2 Lite): ~5s, ~${usd("gemini-3.1-flash-lite-image", "1K")}, 1K only. Cheapest Gemini model; drafts and batches.
- gemini-3.1-flash-image (Nano Banana 2, DEFAULT): ~11s, ~${usd("gemini-3.1-flash-image", "0.5K")} (0.5K) / ${usd("gemini-3.1-flash-image", "1K")} (1K) / ${usd("gemini-3.1-flash-image", "2K")} (2K) / ${usd("gemini-3.1-flash-image", "4K")} (4K); the only model with 1:4, 4:1, 1:8, 8:1. Best everyday choice.
- gemini-3-pro-image (Nano Banana Pro): ~17s, ~${usd("gemini-3-pro-image", "1K")} (1K/2K) to ~${usd("gemini-3-pro-image", "4K")} (4K). Photorealism, hero shots, factual content.
- gpt-image-2.5-flare (OpenAI): cost and time follow \`quality\`: low ~$0.006/10s, medium ~$0.013/14s, high ~$0.05/18s, xhigh ~$0.09/27s, max ~$0.21/46s. The cheapest image overall is flare at low. Single subjects and short text.
- gpt-image-2.5-sunburst (OpenAI): same prices, about 1.5-2x slower (high ~30s, max ~85s). Multi-element text layouts, branding, and edits where precision matters.
OpenAI models take 1K (~1 megapixel) or 2K (~4 megapixels, about twice the cost) at the ten base ratios; the exact pixel size is derived from the ratio. Results carry each image's pixel size and an estimated cost (Google's per-image price on Gemini, token-based on OpenAI); either is omitted rather than guessed when the response does not carry it. Gemini models produce jpeg only; OpenAI models produce jpeg, png or webp and can render a transparent background (png/webp only). A model whose provider key is not configured on the server fails at call time with an error naming the variable.`;

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
 *
 * A token count is summed over the reports that carry it and omitted entirely
 * when none does: a 0 would claim the provider charged nothing for it, which is
 * a different statement from "the provider did not say". Every request in one
 * call goes to one model, so they share one cost basis: the first report's.
 */
function sumUsage(usages: UsageReport[]): UsageReport | undefined {
  const [first] = usages;
  if (!first) return undefined;

  const sum = (count: (usage: UsageReport) => number | undefined) => {
    const reported = usages.flatMap((usage) => count(usage) ?? []);
    return reported.length ? reported.reduce((total, n) => total + n, 0) : undefined;
  };
  const inputTokens = sum((usage) => usage.inputTokens);
  const outputTokens = sum((usage) => usage.outputTokens);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    estimatedCostUsd: usages.reduce((total, usage) => total + usage.estimatedCostUsd, 0),
    costBasis: first.costBasis,
  };
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
      ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
      estimated_cost_usd: usage.estimatedCostUsd,
      cost_basis: usage.costBasis,
      // The same two numbers the text line's scope clause uses, so a caller
      // reading either channel sees the same scope.
      requests_succeeded: successfulRequests,
      requests_reported: usages.length,
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
    // A cost can arrive without counts (Google prices per image), so name only
    // the counts the provider reported rather than printing an undefined.
    const counts = [
      usage.inputTokens !== undefined ? `${usage.inputTokens} input` : undefined,
      usage.outputTokens !== undefined ? `${usage.outputTokens} output` : undefined,
    ].filter((count) => count !== undefined);
    const tokens = counts.length ? `${counts.join(" + ")} tokens, ` : "";
    textContent += `\n\nUsage${scope}: ${tokens}estimated cost $${usage.estimatedCostUsd.toFixed(4)}`;
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

/**
 * Whether a type is worth retrying when nothing about the call changes. The
 * provider mappers override API_ERROR, the one type that spans both a 500 and
 * a 400; this table is the answer for every other type and the fallback for an
 * API_ERROR raised outside a mapper.
 */
const RETRYABLE_BY_TYPE: Record<ErrorType, boolean> = {
  [ErrorType.MISSING_API_KEY]: false,
  [ErrorType.INVALID_IMAGE_PATH]: false,
  [ErrorType.IMAGE_TOO_LARGE]: false,
  [ErrorType.API_RATE_LIMIT]: true,
  [ErrorType.CONTENT_BLOCKED]: false,
  [ErrorType.FILE_WRITE_ERROR]: false,
  [ErrorType.API_ERROR]: true,
  [ErrorType.INVALID_MODEL_OPTION]: false,
  [ErrorType.UNKNOWN_ERROR]: false,
};

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
    error_type: error instanceof McpError ? error.type : ErrorType.UNKNOWN_ERROR,
    retryable:
      error instanceof McpError
        ? (error.retryable ?? RETRYABLE_BY_TYPE[error.type])
        : false,
  };

  return {
    content: [{ type: "text", text: errorMessage }],
    structuredContent: output,
    isError: true,
  };
}
