/**
 * OpenAI GPT Image 2.5 client.
 *
 * Uses the Images API (client.images.generate / client.images.edit). Pixel
 * sizes are derived here from the public aspect_ratio + resolution tokens
 * because OpenAI takes a free-form "WIDTHxHEIGHT" rather than a resolution
 * token; see `openaiSize` for the rule.
 */

import { providerRequestError } from "./errors.js";
import { throwIfImageCancelled } from "../services/image-operation.js";
import OpenAI, { APIError, toFile } from "openai";
import type { ImagesResponse } from "openai/resources/images";
import {
  DEFAULTS,
  ENV_VARS,
  MIME_TYPES,
  OPENAI_PRICE_PER_MILLION_TOKENS,
  type ImageModel,
  type Quality,
  type Resolution,
} from "../constants.js";
import {
  type GeneratedImage,
  type GenerationConfig,
  type ImageResponse,
  type InputImage,
  type UsageReport,
  ToolError,
  ErrorType,
} from "../types.js";

/**
 * Target pixel count for each resolution token, matching Gemini's "area"
 * reading of the tokens rather than OpenAI's 1024x1536-style presets.
 */
const RESOLUTION_PIXEL_AREA: Record<Resolution, number> = {
  "0.5K": 512 ** 2,
  "1K": 1024 ** 2,
  "2K": 2048 ** 2,
  "4K": 4096 ** 2,
};

/**
 * Derive the `size` request value from the public aspect ratio + resolution.
 *
 * Both edges are rounded to a multiple of 16, which the API requires. Without
 * an aspect ratio (edit "auto") the provider chooses the output size.
 */
export function openaiSize(config: GenerationConfig): string {
  if (!config.aspectRatio) return "auto";

  const [w, h] = config.aspectRatio.split(":").map(Number);
  const area = RESOLUTION_PIXEL_AREA[config.resolution ?? DEFAULTS.resolution];
  const to16 = (value: number) => Math.round(value / 16) * 16;

  return `${to16(Math.sqrt((area * w) / h))}x${to16(Math.sqrt((area * h) / w))}`;
}

/** Human-readable provider name, for the startup banner. */
export const label = "OpenAI (GPT Image 2.5)";

/** Whether this provider can be used at all; never throws. */
export function hasApiKey(): boolean {
  return Boolean(process.env[ENV_VARS.openaiApiKey]);
}

/**
 * Get the OpenAI API key, or explain which model cannot be used without it.
 */
export function getApiKey(model: ImageModel): string {
  const apiKey = process.env[ENV_VARS.openaiApiKey];

  if (!apiKey) {
    throw new ToolError(
      ErrorType.MISSING_API_KEY,
      `The server has no OpenAI API key, so '${model}' cannot be used.`,
      `Have the server operator set ${ENV_VARS.openaiApiKey} in the server environment. Do not put API keys in tool arguments.`
    );
  }

  return apiKey;
}

/**
 * Singleton OpenAI client instance
 */
let clientInstance: OpenAI | null = null;

/**
 * Get or create the OpenAI client
 */
function getClient(model: ImageModel): OpenAI {
  if (!clientInstance) {
    // logLevel pins the SDK's logging: an ambient OPENAI_LOG=debug would
    // otherwise write to stdout, which is the MCP protocol channel.
    clientInstance = new OpenAI({ apiKey: getApiKey(model), logLevel: "warn" });
  }
  return clientInstance;
}

/**
 * The settings a request is built from, which the tools also echo in their
 * result: the options OpenAI takes, with its defaults for the ones the caller
 * omitted. Without an aspect ratio (edit "auto") the provider chooses the size,
 * so no resolution applies. temperature is not sent (validation rejects it).
 */
export function effectiveConfig(
  config: GenerationConfig
): GenerationConfig & { quality: Quality; transparentBackground: boolean } {
  return {
    model: config.model,
    aspectRatio: config.aspectRatio,
    resolution: config.aspectRatio ? config.resolution ?? DEFAULTS.resolution : undefined,
    outputFormat: config.outputFormat,
    quality: config.quality ?? DEFAULTS.quality,
    transparentBackground: config.transparentBackground ?? false,
  };
}

/** The size a request is sent with, which the API returns; undefined when the provider chooses ("auto"). */
export function expectedSize(config: GenerationConfig): string | undefined {
  const size = openaiSize(effectiveConfig(config));
  return size === "auto" ? undefined : size;
}

/**
 * The request fields both images.generate and images.edit share.
 *
 * `background` is always explicit so the provider never picks for us; a
 * transparent one is rejected in validation unless the format has alpha.
 */
function buildCommonParams(config: GenerationConfig) {
  const request = effectiveConfig(config);
  return {
    model: request.model,
    n: 1,
    size: openaiSize(request),
    quality: request.quality,
    output_format: request.outputFormat,
    background: request.transparentBackground ? ("transparent" as const) : ("opaque" as const),
  };
}

/**
 * Turn the reported token counts into a cost estimate. The API bills by token,
 * so this is arithmetic over the hand-maintained price table, not a quote.
 */
function toUsageReport(usage: ImagesResponse["usage"]): UsageReport | undefined {
  // No breakdown means no cost estimate; the image itself is still returned.
  if (!usage?.input_tokens_details) return undefined;

  const { text_tokens, image_tokens } = usage.input_tokens_details;
  const estimatedCostUsd =
    (text_tokens * OPENAI_PRICE_PER_MILLION_TOKENS.textInput +
      image_tokens * OPENAI_PRICE_PER_MILLION_TOKENS.imageInput +
      usage.output_tokens * OPENAI_PRICE_PER_MILLION_TOKENS.imageOutput) /
    1_000_000;

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estimatedCostUsd,
    costBasis: "tokens" as const,
  };
}

/** Split the response's "WIDTHxHEIGHT" into numbers; "auto" yields neither. */
function parseSize(size?: string): { width?: number; height?: number } {
  const match = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Extract images and usage from an Images API response.
 */
export function parseImagesResponse(
  response: ImagesResponse,
  config: GenerationConfig
): ImageResponse {
  // A format we did not ask for would be saved under the requested extension
  // and misreported in `images[].format`, so refuse it instead.
  if (response.output_format && response.output_format !== config.outputFormat) {
    return {
      images: [], usage: toUsageReport(response.usage),
      issue: {
        code: ErrorType.API_ERROR,
        message: `OpenAI returned ${response.output_format} instead of the requested ${config.outputFormat}; this response could not be used.`,
        next_step: "Report the unexpected format. If another paid attempt is acceptable, submit a new request; the original request may still incur a charge.",
      },
    };
  }

  const mimeType = MIME_TYPES[config.outputFormat];
  const { width, height } = parseSize(response.size);

  const images: GeneratedImage[] = [];
  for (const image of response.data ?? []) {
    if (image.b64_json) {
      images.push({ data: image.b64_json, mimeType, width, height });
    }
  }

  return { images, usage: toUsageReport(response.usage) };
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  throwIfImageCancelled(signal);
  const client = getClient(config.model);

  // Only the SDK call is mapped by handleApiError.
  let response: ImagesResponse;
  try {
    response = await client.images.generate({
      ...buildCommonParams(config),
      prompt,
    }, { signal, maxRetries: 0 });
  } catch (error) {
    handleApiError(error, config.model, signal);
  }

  return parseImagesResponse(response, config);
}

/**
 * Edit images using a text prompt.
 *
 * Each input is uploaded with an explicit MIME type: a buffer without one is
 * sent as application/octet-stream and rejected by the API.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  throwIfImageCancelled(signal);
  const client = getClient(config.model);

  const image = await Promise.all(
    inputImages.map((input, index) =>
      toFile(
        Buffer.from(input.data, "base64"),
        `image-${index + 1}.${input.mimeType.split("/")[1] ?? "png"}`,
        { type: input.mimeType }
      )
    )
  );

  let response: ImagesResponse;
  try {
    response = await client.images.edit({
      ...buildCommonParams(config),
      prompt,
      image,
    }, { signal, maxRetries: 0 });
  } catch (error) {
    handleApiError(error, config.model, signal);
  }

  return parseImagesResponse(response, config);
}

/** Translate explicit provider evidence; never infer delivery from a missing status. */
function handleApiError(error: unknown, model: ImageModel, signal?: AbortSignal): never {
  const apiError = error instanceof APIError ? error : undefined;
  throw providerRequestError("OpenAI", model, {
    status: apiError?.status,
    reason: apiError?.message.replace(/^\d{3} /, ""),
    contentBlocked: apiError?.code === "moderation_blocked",
    quotaExhausted: apiError?.code === "insufficient_quota",
    cancelled: signal?.aborted,
  }, error);
}
