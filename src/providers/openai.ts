/**
 * OpenAI GPT Image 2.5 client.
 *
 * Uses the Images API (client.images.generate / client.images.edit). Pixel
 * sizes are derived here from the public aspect_ratio + resolution tokens
 * because OpenAI takes a free-form "WIDTHxHEIGHT" rather than a resolution
 * token; see `openaiSize` for the rule.
 */

import OpenAI, { APIError, toFile } from "openai";
import type { ImagesResponse } from "openai/resources/images";
import {
  DEFAULTS,
  ENV_VARS,
  MIME_TYPES,
  OPENAI_PRICE_PER_MILLION_TOKENS,
  type ImageModel,
  type Resolution,
} from "../constants.js";
import {
  type GeneratedImage,
  type GenerationConfig,
  type ImageResponse,
  type InputImage,
  type UsageReport,
  McpError,
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
 * an aspect ratio (edit "auto") the provider picks a size near the input's.
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
function getApiKey(model: ImageModel): string {
  const apiKey = process.env[ENV_VARS.openaiApiKey];

  if (!apiKey) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      `Error: ${ENV_VARS.openaiApiKey} is not set, so '${model}' cannot be used. Set ${ENV_VARS.openaiApiKey} in the MCP server's environment, or choose a Gemini model.`
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
    clientInstance = new OpenAI({ apiKey: getApiKey(model) });
  }
  return clientInstance;
}

/**
 * The request fields both images.generate and images.edit share.
 *
 * `background` is always explicit so the provider never picks for us.
 */
function buildCommonParams(config: GenerationConfig) {
  return {
    model: config.model,
    n: 1,
    size: openaiSize(config),
    quality: config.quality ?? DEFAULTS.quality,
    output_format: config.outputFormat,
    background: "opaque" as const,
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
  const mimeType = MIME_TYPES[config.outputFormat];
  const { width, height } = parseSize(response.size);

  const images: GeneratedImage[] = [];
  for (const image of response.data ?? []) {
    if (image.b64_json) {
      images.push({ data: image.b64_json, mimeType, width, height });
    }
  }

  if (images.length === 0) {
    throw new McpError(
      ErrorType.API_ERROR,
      "Error: OpenAI returned no image for this request. Retry, or rephrase the prompt."
    );
  }

  return { images, usage: toUsageReport(response.usage) };
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig
): Promise<ImageResponse> {
  const client = getClient(config.model);

  // Only the SDK call is mapped by handleApiError; parsing raises its own
  // McpErrors and must not be relabelled as a request failure.
  let response: ImagesResponse;
  try {
    response = await client.images.generate({
      ...buildCommonParams(config),
      prompt,
    });
  } catch (error) {
    handleApiError(error, config.model, false);
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
  config: GenerationConfig
): Promise<ImageResponse> {
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
    });
  } catch (error) {
    handleApiError(error, config.model, true);
  }

  return parseImagesResponse(response, config);
}

/** The error body fields we read beyond what APIError exposes directly. */
interface OpenAiErrorBody {
  message?: string;
  moderation_details?: {
    moderation_stage?: string;
    categories?: unknown;
  };
}

/**
 * Map an OpenAI SDK error to an McpError whose message says what to do next.
 */
function handleApiError(
  error: unknown,
  model: ImageModel,
  hasInputImages: boolean
): never {
  // Preserve McpErrors we raised ourselves (e.g. missing key, no image back).
  if (error instanceof McpError) {
    throw error;
  }

  if (!(error instanceof APIError)) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorType.API_ERROR,
      `Error: OpenAI request failed: ${message}. Retry; if it persists, try the other provider.`,
      error
    );
  }

  const body = error.error as OpenAiErrorBody | undefined;
  const apiMessage = body?.message ?? error.message;

  if (error.code === "moderation_blocked") {
    const details = body?.moderation_details;
    const categories = Array.isArray(details?.categories)
      ? details.categories.join(", ")
      : "unspecified";
    throw new McpError(
      ErrorType.CONTENT_BLOCKED,
      `Error: OpenAI's content moderation blocked this request (${details?.moderation_stage ?? "unknown stage"}; categories: ${categories}). Rephrase the prompt or change the input images.`,
      error
    );
  }

  switch (error.status) {
    case 401:
      throw new McpError(
        ErrorType.MISSING_API_KEY,
        `Error: OpenAI rejected the API key (401): ${apiMessage}. Check ${ENV_VARS.openaiApiKey}.`,
        error
      );
    case 403:
      throw new McpError(
        ErrorType.API_ERROR,
        `Error: OpenAI denied access (403): ${apiMessage}. GPT Image models may require organisation verification in the OpenAI dashboard; otherwise choose a Gemini model.`,
        error
      );
    case 404:
      throw new McpError(
        ErrorType.API_ERROR,
        `Error: OpenAI reports model '${model}' was not found: ${apiMessage}. The model ID may have been retired; try the other OpenAI model or a Gemini model.`,
        error
      );
    case 429:
      throw new McpError(
        ErrorType.API_RATE_LIMIT,
        `Error: OpenAI rate limit exceeded (429): ${apiMessage}. Wait a minute and retry, lower num_images, or use a Gemini model.`,
        error
      );
  }

  if (error.status !== undefined && error.status >= 400 && error.status < 500) {
    const inputHint = hasInputImages
      ? "; input images must be jpeg, png or webp"
      : "";
    throw new McpError(
      ErrorType.API_ERROR,
      `Error: OpenAI rejected the request: ${apiMessage}. Adjust the arguments accordingly${inputHint}.`,
      error
    );
  }

  throw new McpError(
    ErrorType.API_ERROR,
    `Error: OpenAI request failed (${error.status ?? "network"}): ${apiMessage}. Retry; if it persists, try the other provider.`,
    error
  );
}
