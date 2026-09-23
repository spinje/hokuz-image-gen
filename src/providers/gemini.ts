/**
 * Gemini API Client for Nano Banana image generation/editing.
 *
 * Uses the Gemini Interactions API (ai.interactions.create), which is the
 * generally-available, recommended path for the current image models.
 */

import { providerRequestError } from "./errors.js";
import { throwIfImageCancelled } from "../services/image-operation.js";
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
  ToolError,
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
export function getApiKey(): string {
  const apiKey = resolveApiKey();

  if (!apiKey) {
    throw new ToolError(
      ErrorType.MISSING_API_KEY,
      "The server has no Gemini API key.",
      `Have the server operator set ${ENV_VARS.geminiApiKey} (or ${ENV_VARS.googleApiKey}) in the server environment. Do not put API keys in tool arguments.`
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
 * - `aspect_ratio` is only included when defined (edit "auto" leaves the
 *   ratio to the model).
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
    if (isSof) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      // A zero edge means we misread the segment; report nothing rather than
      // publish a 0x0 that the response text would silently drop anyway.
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * Extract images, text description and usage from an interaction response.
 *
 * `imagePriceUsd` is what Google charges for one image of the requested model
 * and resolution; without it the result carries no usage rather than a cost
 * this module cannot stand behind. The token counts ride along when the
 * response reports them, but they never price the image.
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
    images.push({
      data,
      mimeType: mimeType ?? "image/jpeg",
      ...jpegDimensions(Buffer.from(data, "base64")),
    });
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

  const { total_input_tokens: inputTokens, total_output_tokens: outputTokens } =
    interaction.usage ?? {};
  // The price decides whether there is a report; the counts are attached when
  // the response carried them.
  const usage =
    imagePriceUsd === undefined
      ? undefined
      : {
          ...(typeof inputTokens === "number" ? { inputTokens } : {}),
          ...(typeof outputTokens === "number" ? { outputTokens } : {}),
          // Google bills per image, so the cost scales with what came back.
          estimatedCostUsd: imagePriceUsd * images.length,
          costBasis: "per_image" as const,
        };

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
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  throwIfImageCancelled(signal);
  const client = getClient();

  let interaction: InteractionLike;
  try {
    interaction = await client.interactions.create({
      model: config.model,
      input: prompt,
      response_format: buildResponseFormat(config),
      generation_config: { temperature: config.temperature ?? DEFAULTS.temperature },
    }, { signal, maxRetries: 0 });
  } catch (error) {
    handleApiError(error, config.model, signal);
  }
  return parseInteraction(interaction, imagePriceUsd(config));
}

/**
 * Edit images using a text prompt.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  throwIfImageCancelled(signal);
  const client = getClient();

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

  let interaction: InteractionLike;
  try {
    interaction = await client.interactions.create({
      model: config.model,
      input,
      response_format: buildResponseFormat(config),
      generation_config: { temperature: config.temperature ?? DEFAULTS.temperature },
    }, { signal, maxRetries: 0 });
  } catch (error) {
    handleApiError(error, config.model, signal);
  }
  return parseInteraction(interaction, imagePriceUsd(config));
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
 * Normally it is in the parsed field (`error.error.message`). An invalid API key
 * is the exception: the SDK leaves that field empty and puts the reason in the
 * raw body, which is a JSON array, so the body is parsed as a fallback. Anything
 * else falls back to the SDK's own message, whose "<status> " prefix would
 * otherwise be repeated by our own text.
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
 * The HTTP status of a failed request, or undefined when no HTTP status is available. `status` is a number on every shape captured so far, but the class
 * that carries it is internal to the SDK, so a bump could rename or re-type it.
 * Falling back to the `"<status> "` prefix the SDK puts on every HTTP message
 * keeps a key rejection from being misread as a network failure worth retrying.
 */
function resolveStatus(error: GeminiApiErrorLike): number | undefined {
  if (typeof error.status === "number") return error.status;
  if (typeof error.status === "string" && /^\d{3}$/.test(error.status)) {
    return Number(error.status);
  }
  const prefixed = typeof error.message === "string" && /^(\d{3}) /.exec(error.message);
  return prefixed ? Number(prefixed[1]) : undefined;
}

/** Keep the Gemini-specific response shapes here; share recovery policy. */
function handleApiError(error: unknown, model: ImageModel, signal?: AbortSignal): never {
  const apiError = (error ?? {}) as GeminiApiErrorLike;
  const reason = apiMessage(apiError);
  const status = resolveStatus(apiError);
  throw providerRequestError("Gemini", model, {
    status,
    reason,
    keyRejected: status === 400 && /api key/i.test(reason + (typeof apiError.body === "string" ? apiError.body : "")),
    // Require an explicit moderation statement, not merely the word "blocked".
    contentBlocked: status === 400 && /(?:blocked by (?:the )?(?:safety|content)|(?:safety|content moderation|safety filters?).*(?:blocked|rejected))/i.test(reason),
    cancelled: signal?.aborted,
  }, error);
}
