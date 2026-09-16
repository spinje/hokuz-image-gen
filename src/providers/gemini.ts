/**
 * Gemini API Client for Nano Banana image generation/editing.
 *
 * Uses the Gemini Interactions API (ai.interactions.create), which is the
 * generally-available, recommended path for the current image models.
 */

import { GoogleGenAI } from "@google/genai";
import {
  DEFAULTS,
  ENV_VARS,
  GEMINI_PRICE_PER_IMAGE_USD,
  MIME_TYPES,
  type ImageModel,
  type Resolution,
} from "../constants.js";
import {
  type GenerationConfig,
  type ImageResponse,
  type GeneratedImage,
  type InputImage,
  McpError,
  ErrorType,
} from "../types.js";

/**
 * Maps a public resolution token to the Interactions API `image_size` value,
 * which uses "512" rather than "0.5K".
 */
const IMAGE_SIZE_API_VALUES: Record<Resolution, string> = {
  "0.5K": "512",
  "1K": "1K",
  "2K": "2K",
  "4K": "4K",
};

/** Human-readable provider name, for the startup banner. */
export const label = "Google Gemini (Nano Banana)";

/**
 * Read the API key from the environment.
 * GEMINI_API_KEY is preferred; GOOGLE_API_KEY is accepted for compatibility.
 */
function resolveApiKey(): string | undefined {
  return process.env[ENV_VARS.geminiApiKey] || process.env[ENV_VARS.googleApiKey];
}

/** Whether this provider can be used at all; never throws. */
export function hasApiKey(): boolean {
  return Boolean(resolveApiKey());
}

/**
 * Get the API key, or explain which variable to set.
 */
function getApiKey(): string {
  const apiKey = resolveApiKey();

  if (!apiKey) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      `Error: ${ENV_VARS.geminiApiKey} is not set, so Gemini models cannot be used. Set ${ENV_VARS.geminiApiKey} (or ${ENV_VARS.googleApiKey}) in the MCP server's environment — get a key at https://aistudio.google.com/ — or choose an OpenAI model.`
    );
  }

  return apiKey;
}

/**
 * Singleton Gemini client instance
 */
let clientInstance: GoogleGenAI | null = null;

/**
 * Get or create the Gemini client
 */
function getClient(): GoogleGenAI {
  if (!clientInstance) {
    const apiKey = getApiKey();
    clientInstance = new GoogleGenAI({ apiKey });
  }
  return clientInstance;
}

/**
 * Build the `response_format` object for an image interaction.
 *
 * - `mime_type` is "image/jpeg". These models output JPEG only; the API
 *   rejects any other value (verified live: "image/png" returns a 400).
 * - `aspect_ratio` is only included when defined (edit "auto" omits it so the
 *   model preserves the input image's native ratio).
 * - a config without a resolution gets this provider's default.
 */
function buildResponseFormat(config: GenerationConfig) {
  return {
    type: "image" as const,
    image_size: IMAGE_SIZE_API_VALUES[config.resolution ?? DEFAULTS.resolution],
    mime_type: MIME_TYPES[config.outputFormat] as "image/jpeg",
    ...(config.aspectRatio ? { aspect_ratio: config.aspectRatio } : {}),
  };
}

/**
 * The shape of an interaction returned by the SDK, narrowed to the fields we
 * consume. Kept local to avoid depending on non-exported SDK type aliases.
 */
export interface InteractionLike {
  status?: string;
  output_text?: string;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
  output_image?: { data?: string; mime_type?: string };
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      data?: string;
      mime_type?: string;
    }>;
    error?: { message?: string };
  }>;
}

/**
 * Read a JPEG's pixel size from its SOF segment. The API reports no dimensions,
 * and these models return JPEG only (gotcha 3), so this is the whole decoder:
 * anything that is not a JPEG we can walk gets no width/height.
 */
function jpegDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined; // lost marker sync
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI or scan data before any SOF
    const length = buf.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return undefined;
}

/**
 * Extract images, text description and usage from an interaction response.
 *
 * `imagePriceUsd` is what Google charges for one image of the requested model
 * and resolution; without it the result carries no usage rather than a cost
 * this module cannot stand behind.
 */
export function parseInteraction(
  interaction: InteractionLike,
  imagePriceUsd?: number
): ImageResponse {
  const images: GeneratedImage[] = [];
  const seen = new Set<string>();
  let description: string | undefined;

  const addImage = (data?: string, mimeType?: string) => {
    if (!data || seen.has(data)) return;
    seen.add(data);
    const mime = mimeType ?? "image/jpeg";
    const dimensions =
      mime === "image/jpeg" ? jpegDimensions(Buffer.from(data, "base64")) : undefined;
    images.push({ data, mimeType: mime, ...dimensions });
  };

  const addText = (text?: string) => {
    if (!text) return;
    description = description ? `${description}\n${text}` : text;
  };

  // Convenience field: the last generated image.
  if (interaction.output_image) {
    addImage(interaction.output_image.data, interaction.output_image.mime_type);
  }

  // Also scan model output steps for any additional image/text content blocks.
  for (const step of interaction.steps ?? []) {
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (block.type === "image") {
        addImage(block.data, block.mime_type);
      } else if (block.type === "text") {
        addText(block.text);
      }
    }
  }

  // Fall back to the SDK's concatenated output_text if no step text was found.
  if (!description) {
    addText(interaction.output_text);
  }

  if (images.length === 0) {
    throw new McpError(
      ErrorType.CONTENT_BLOCKED,
      "Error: No images were generated. The content may have been blocked by safety filters. Try modifying your prompt."
    );
  }

  const { total_input_tokens: inputTokens, total_output_tokens: outputTokens } =
    interaction.usage ?? {};
  const usage =
    typeof inputTokens === "number" &&
    typeof outputTokens === "number" &&
    imagePriceUsd !== undefined
      ? {
          inputTokens,
          outputTokens,
          // Google bills per image, so the cost scales with what came back.
          estimatedCostUsd: imagePriceUsd * images.length,
        }
      : undefined;

  return { images, description, usage };
}

/**
 * What one image of this request costs, or undefined for a model/resolution
 * the price table does not carry (unreachable: validation guarantees the
 * resolution is supported and `constants.test.ts` guarantees it has a price).
 */
function imagePriceUsd(config: GenerationConfig): number | undefined {
  return GEMINI_PRICE_PER_IMAGE_USD[config.model]?.[config.resolution ?? DEFAULTS.resolution];
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig
): Promise<ImageResponse> {
  const client = getClient();

  try {
    const interaction = await client.interactions.create({
      model: config.model,
      input: prompt,
      response_format: buildResponseFormat(config),
      generation_config: { temperature: config.temperature ?? DEFAULTS.temperature },
    });

    return parseInteraction(interaction as InteractionLike, imagePriceUsd(config));
  } catch (error) {
    return handleApiError(error, config.model);
  }
}

/**
 * Edit images using a text prompt.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig
): Promise<ImageResponse> {
  const client = getClient();

  try {
    // Input images first (preserving order for "first image" / "second image"
    // references), then the editing instruction.
    const input = [
      ...inputImages.map((image) => ({
        type: "image" as const,
        mime_type: image.mimeType,
        data: image.data,
      })),
      { type: "text" as const, text: prompt },
    ];

    const interaction = await client.interactions.create({
      model: config.model,
      input,
      response_format: buildResponseFormat(config),
      generation_config: { temperature: config.temperature ?? DEFAULTS.temperature },
    });

    return parseInteraction(interaction as InteractionLike, imagePriceUsd(config));
  } catch (error) {
    return handleApiError(error, config.model);
  }
}

/**
 * The fields the SDK's error classes carry that we read. `@google/genai` throws
 * an internal Stainless-style hierarchy it does not export (the exported
 * `ApiError` is a different, unused class), so there is nothing to `instanceof`
 * against and the mapping below duck-types instead.
 */
interface GeminiApiErrorLike {
  status?: unknown;
  message?: unknown;
  body?: unknown;
  error?: { error?: { message?: unknown } };
}

/**
 * Google's own message for a failed request.
 *
 * Normally it is in the parsed body (`error.error.message`). An invalid API key
 * is the exception: the SDK leaves the body unparsed and it is a JSON array, so
 * that case is read from `body`. Anything else falls back to the SDK's message,
 * whose "<status> " prefix would otherwise be repeated by our own text.
 */
function apiMessage(error: GeminiApiErrorLike): string {
  const structured = error.error?.error?.message;
  if (typeof structured === "string") return structured;

  if (typeof error.body === "string") {
    try {
      const parsed: unknown = JSON.parse(error.body);
      const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
      const message = (first as { error?: { message?: unknown } } | undefined)?.error?.message;
      if (typeof message === "string") return message;
    } catch {
      // Not JSON; fall through to the SDK's own message.
    }
  }

  if (typeof error.message === "string") return error.message.replace(/^\d{3} /, "");
  return String(error);
}

/**
 * Map a Gemini SDK error to an McpError whose message says what to do next.
 *
 * Classification is by HTTP status, like the OpenAI module's. The two text
 * checks are deliberate exceptions: a rejected API key comes back as a 400 with
 * no distinguishing code, and a safety block has no code either (no real block
 * was triggered while capturing these shapes, so the wording is a best guess).
 */
function handleApiError(error: unknown, model: ImageModel): never {
  // Preserve McpErrors we raised ourselves (e.g. validation, content blocked).
  if (error instanceof McpError) {
    throw error;
  }

  const apiError = (error ?? {}) as GeminiApiErrorLike;
  const message = apiMessage(apiError);
  const status = typeof apiError.status === "number" ? apiError.status : undefined;

  // No status at all means the request never reached Google (connection,
  // timeout, abort).
  if (status === undefined) {
    throw new McpError(
      ErrorType.API_ERROR,
      `Error: Gemini request failed (network): ${message}. Retry; if it persists, try an OpenAI model.`,
      error
    );
  }

  if (status === 400) {
    const body = typeof apiError.body === "string" ? apiError.body : "";
    if (/api key/i.test(message) || /api key/i.test(body)) {
      throw new McpError(
        ErrorType.MISSING_API_KEY,
        `Error: Gemini rejected the API key: ${message}. Check ${ENV_VARS.geminiApiKey} (or ${ENV_VARS.googleApiKey}), or choose an OpenAI model.`,
        error
      );
    }
    if (/safety|blocked/i.test(message)) {
      throw new McpError(
        ErrorType.CONTENT_BLOCKED,
        `Error: Gemini's safety filters blocked this request: ${message}. Rephrase the prompt or change the input images.`,
        error
      );
    }
  }

  switch (status) {
    case 401:
    case 403:
      throw new McpError(
        ErrorType.MISSING_API_KEY,
        `Error: Gemini denied the request (${status}): ${message}. Check ${ENV_VARS.geminiApiKey} (or ${ENV_VARS.googleApiKey}) and the project's billing, or choose an OpenAI model.`,
        error
      );
    case 404:
      throw new McpError(
        ErrorType.API_ERROR,
        `Error: Gemini reports model '${model}' was not found (${message}). The model ID may have been retired, or this resolution is not offered for it; try another Gemini model or an OpenAI model.`,
        error
      );
    case 429:
      throw new McpError(
        ErrorType.API_RATE_LIMIT,
        `Error: Gemini rate limit exceeded (429): ${message}. Wait a minute and retry, lower num_images, or use an OpenAI model.`,
        error
      );
  }

  if (status >= 400 && status < 500) {
    throw new McpError(
      ErrorType.API_ERROR,
      `Error: Gemini rejected the request (${status}): ${message}. Adjust the arguments accordingly.`,
      error
    );
  }

  throw new McpError(
    ErrorType.API_ERROR,
    `Error: Gemini request failed (${status}): ${message}. Retry; if it persists, try an OpenAI model.`,
    error
  );
}
