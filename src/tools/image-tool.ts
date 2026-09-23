/**
 * The pipeline both image tools run once their arguments are mapped and
 * validated: the num_images loop, saving, usage, the issue, the response
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
import { createImagePreview, PreviewUnavailable } from "../services/image-preview.js";
import { throwIfImageCancelled } from "../services/image-operation.js";
import type { ImageToolOutput } from "../schemas/output.js";
import { saveBase64Image } from "../services/file-utils.js";
import {
  ErrorType,
  ToolError,
  type GeneratedImage,
  type ImageResponse,
  type ToolIssue,
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
OpenAI models take 1K (~1 megapixel) or 2K (~4 megapixels, about twice the cost) at the ten base ratios; requested dimensions are derived from the ratio and rounded to multiples of 16. Aspect ratios are targets: OpenAI rounding and Gemini output can produce different file ratios. For exact layouts, check returned width/height when available, or inspect the saved file. Results carry each image's pixel size and an estimated cost (Google's per-image price on Gemini, token-based on OpenAI); either is omitted rather than guessed when the response does not carry it. Gemini models produce jpeg only; OpenAI models produce jpeg, png or webp and can render a transparent background (png/webp only). A model whose provider key is not configured on the server fails at call time with an error naming the variable.`;

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
  includePreview?: boolean;
  signal?: AbortSignal;
  /** One paid provider request, without automatic retries. */
  produce: () => Promise<ImageResponse>;
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

/** Save each response before requesting more; a later failure never hides files. */
export async function runImageTool({
  outputFormat, outputPath, requestedCount, includePreview = false, signal, produce,
}: ImageToolRun): Promise<CallToolResult> {
  const outputImages: ImageToolOutput["images"] = [];
  const previewInputs: GeneratedImage[] = [];
  const descriptions: string[] = [];
  const usages: UsageReport[] = [];
  let completedRequests = 0;
  let issue: ToolIssue | undefined;

  while (outputImages.length < requestedCount) {
    let response: ImageResponse;
    try {
      throwIfImageCancelled(signal);
      response = await produce();
    } catch (error) {
      issue = issueFromError(error);
      break;
    }
    completedRequests++;
    if (response.description) descriptions.push(response.description);
    if (response.usage) usages.push(response.usage);
    if (!response.images.length) {
      issue = response.issue ?? {
        code: ErrorType.API_ERROR,
        message: "The provider returned no usable image.",
        next_step: "Read any model response for context. If another paid attempt is appropriate, submit a new request; the original request may still incur a charge.",
      };
      break;
    }
    const images = response.images.slice(0, requestedCount - outputImages.length);
    let savedFromResponse = 0;
    try {
      // Even after cancellation, save images already returned by the provider.
      for (const image of images) {
        const filePath = await saveBase64Image(image.data, outputPath, outputFormat, outputImages.length);
        outputImages.push({ path: filePath, format: outputFormat, width: image.width, height: image.height });
        if (includePreview) previewInputs.push(image);
        savedFromResponse++;
      }
    } catch (error) {
      const failure = issueFromError(error);
      issue = {
        ...failure,
        message: `${failure.message} Generation returned ${images.length} requested image(s) in this request, but only ${savedFromResponse} were saved.`,
        next_step: `${failure.next_step} The unsaved image(s) cannot be retrieved through this tool; generating replacements requires another paid request.`,
      };
      break;
    }
  }

  // Save all originals first. Preview failure must never lose a paid result.
  const previewContent: CallToolResult["content"] = [];
  if (includePreview) {
    for (let i = 0; i < outputImages.length; i++) {
      const saved = outputImages[i];
      try {
        throwIfImageCancelled(signal);
        const { data, ...preview } = await createImagePreview(previewInputs[i].data, previewInputs[i].mimeType, signal);
        throwIfImageCancelled(signal);
        // One summary precedes previewContent; each label precedes its image.
        saved.preview = { ...preview, content_index: previewContent.length + 2 };
        const background = preview.background === "white_and_navy"
          ? "White background left; navy right."
          : "Original opaque appearance.";
        previewContent.push({
          type: "text",
          text: `Derived JPEG preview for ${saved.path} (${preview.width}x${preview.height}). ${background} ` +
            `Original alpha: channel ${preview.alpha.has_channel ? "present" : "absent"}, min ${preview.alpha.min}, max ${preview.alpha.max} ` +
            "(0 transparent; 255 opaque). Saved original unchanged; inspect the original for fine detail. " +
            "This preview does not establish clean edges or preservation.",
        }, { type: "image", mimeType: "image/jpeg", data });
      } catch (error) {
        const reason = signal?.aborted ? "request cancelled"
          : error instanceof PreviewUnavailable ? error.message : "image decoding or processing failed";
        saved.preview_warning = `Preview unavailable: ${reason}. Original saved successfully; inspect ${saved.path} without repeating the image request.`;
      }
    }
  }

  if (issue && outputImages.length) {
    issue = { ...issue, next_step: `${issue.next_step} Keep the ${outputImages.length} saved image(s). If making another request, set num_images to ${requestedCount - outputImages.length} for only the missing images.` };
  }
  const usage = sumUsage(usages);
  return formatImageResult({
    status: issue ? (outputImages.length ? "partial" : "failed") : "complete",
    images: outputImages,
    ...(issue && { issue }),
    ...(descriptions.length && { description: [...new Set(descriptions)].join("\n---\n") }),
    ...(usage && { usage: {
      ...(usage.inputTokens !== undefined && { input_tokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { output_tokens: usage.outputTokens }),
      estimated_cost_usd: usage.estimatedCostUsd,
      cost_basis: usage.costBasis,
      requests_completed: completedRequests,
      requests_reported: usages.length,
    } }),
  }, previewContent, requestedCount);
}

/** One formatter keeps recovery facts identical for text-only and structured clients. */
function formatImageResult(
  output: ImageToolOutput,
  previewContent: CallToolResult["content"] = [],
  requestedCount?: number,
): CallToolResult {
  const { images, issue, usage } = output;
  const count = requestedCount === undefined ? "" : ` of ${requestedCount} requested`;
  const lines = [`${output.status}: ${images.length}${count} image(s) saved.`];
  for (const image of images) {
    lines.push(image.width && image.height ? `${image.path} (${image.width}x${image.height})` : image.path);
  }
  if (issue) lines.push(`\n${issue.message}`, `Next step: ${issue.next_step}`);
  if (usage) {
    const counts = [
      usage.input_tokens !== undefined ? `${usage.input_tokens} input` : undefined,
      usage.output_tokens !== undefined ? `${usage.output_tokens} output` : undefined,
    ].filter((count) => count !== undefined);
    const tokens = counts.length ? `${counts.join(" + ")} tokens, ` : "";
    const basis = usage.cost_basis === "tokens" ? "from those token counts" : "the provider's per-image price, not derived from those tokens";
    lines.push(`\nUsage (reported for ${usage.requests_reported} of ${usage.requests_completed} completed requests): ${tokens}estimated cost $${usage.estimated_cost_usd.toFixed(4)} (${basis}). Only reported usage is included; unreported charges may apply.`);
  }
  if (output.description) lines.push(`\nModel response: ${output.description}`);
  for (const image of images) if (image.preview_warning) lines.push(`\n${image.preview_warning}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }, ...previewContent],
    structuredContent: output,
    ...(output.status === "failed" && { isError: true }),
  };
}

function issueFromError(error: unknown): ToolIssue {
  return error instanceof ToolError ? error.issue : {
    code: ErrorType.UNKNOWN_ERROR,
    message: "An unexpected error prevented completion; the interrupted operation's outcome could not be confirmed.",
    next_step: "Do not automatically repeat the call; report the problem before trying again.",
  };
}

/** The handler knows whether generation was ruled out by preflight. */
export function imageToolError(error: unknown, beforeGeneration: boolean): CallToolResult {
  const issue = issueFromError(error);
  return formatImageResult({
    status: "failed", images: [],
    issue: beforeGeneration ? {
      ...issue,
      message: `${error instanceof ToolError ? issue.message : "An unexpected error prevented the call from starting."} Generation did not start.`,
    } : issue,
  });
}
