/**
 * Gemini API Client for Nano Banana image generation/editing.
 *
 * Uses the Gemini Interactions API (ai.interactions.create), which is the
 * generally-available, recommended path for the current image models.
 */

import { GoogleGenAI } from "@google/genai";
import {
  ENV_VARS,
  MIME_TYPES,
  IMAGE_SIZE_API_VALUES,
  getUnsupportedModelOptionMessage,
  type AspectRatio,
  type Resolution,
  type OutputFormat,
  type ImageModel,
} from "../constants.js";
import {
  type GeminiImageResponse,
  type GeneratedImage,
  type InputImage,
  McpError,
  ErrorType,
} from "../types.js";

/**
 * Configuration for a single image generation/edit request.
 *
 * Note: `numImages` is intentionally NOT part of this config. Requesting
 * multiple images is handled in the tool layer by making repeated independent
 * requests, so the service is always "one request returns whatever it returns".
 */
export interface GenerationConfig {
  model: ImageModel;
  /** Omitted (undefined) means "auto" — do not send an aspect ratio. */
  aspectRatio?: AspectRatio;
  resolution: Resolution;
  temperature: number;
  outputFormat: OutputFormat;
}

/**
 * Get the API key from environment variables.
 * GEMINI_API_KEY is preferred; GOOGLE_API_KEY is accepted for compatibility.
 */
function getApiKey(): string {
  const apiKey =
    process.env[ENV_VARS.geminiApiKey] || process.env[ENV_VARS.googleApiKey];

  if (!apiKey) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      `Error: API key not found. Set the ${ENV_VARS.geminiApiKey} or ${ENV_VARS.googleApiKey} environment variable. Get your key at https://aistudio.google.com/`
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
 * Validate a generation config against the model capability registry.
 * Throws INVALID_MODEL_OPTION before any API request is made.
 */
export function validateGenerationConfig(config: GenerationConfig): void {
  const message = getUnsupportedModelOptionMessage({
    model: config.model,
    resolution: config.resolution,
    aspectRatio: config.aspectRatio,
  });
  if (message) {
    throw new McpError(ErrorType.INVALID_MODEL_OPTION, message);
  }
}

/**
 * Build the `response_format` object for an image interaction.
 *
 * - `mime_type` is "image/jpeg". These models output JPEG only; the API
 *   rejects any other value (verified live: "image/png" returns a 400).
 * - `aspect_ratio` is only included when defined (edit "auto" omits it so the
 *   model preserves the input image's native ratio).
 */
function buildResponseFormat(config: GenerationConfig) {
  return {
    type: "image" as const,
    image_size: IMAGE_SIZE_API_VALUES[config.resolution],
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
 * Extract images and text description from an interaction response.
 */
export function parseInteraction(interaction: InteractionLike): GeminiImageResponse {
  const images: GeneratedImage[] = [];
  const seen = new Set<string>();
  let description: string | undefined;

  const addImage = (data?: string, mimeType?: string) => {
    if (!data || seen.has(data)) return;
    seen.add(data);
    images.push({ data, mimeType: mimeType ?? "image/jpeg" });
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

  return { images, description };
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig
): Promise<GeminiImageResponse> {
  validateGenerationConfig(config);
  const client = getClient();

  try {
    const interaction = await client.interactions.create({
      model: config.model,
      input: prompt,
      response_format: buildResponseFormat(config),
      generation_config: { temperature: config.temperature },
    });

    return parseInteraction(interaction as InteractionLike);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Edit images using a text prompt.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig
): Promise<GeminiImageResponse> {
  validateGenerationConfig(config);
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
      generation_config: { temperature: config.temperature },
    });

    return parseInteraction(interaction as InteractionLike);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Handle API errors and convert to McpError
 */
function handleApiError(error: unknown): never {
  // Preserve McpErrors we raised ourselves (e.g. validation, content blocked).
  if (error instanceof McpError) {
    throw error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  // Check for rate limiting
  if (
    errorMessage.includes("429") ||
    errorMessage.toLowerCase().includes("rate limit")
  ) {
    throw new McpError(
      ErrorType.API_RATE_LIMIT,
      "Error: Rate limit exceeded. Please wait before making more requests."
    );
  }

  // Check for authentication errors
  if (
    errorMessage.includes("401") ||
    errorMessage.includes("403") ||
    errorMessage.toLowerCase().includes("api key")
  ) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      `Error: Invalid or missing API key. Please check your ${ENV_VARS.geminiApiKey} environment variable.`
    );
  }

  // Check for content safety blocks
  if (
    errorMessage.toLowerCase().includes("blocked") ||
    errorMessage.toLowerCase().includes("safety")
  ) {
    throw new McpError(
      ErrorType.CONTENT_BLOCKED,
      "Error: Content was blocked by safety filters. Try modifying your prompt to be less explicit or controversial."
    );
  }

  // Generic API error
  throw new McpError(
    ErrorType.API_ERROR,
    `Error: API request failed. ${errorMessage}`,
    error
  );
}

/**
 * Validate that the client can be initialized (checks for API key)
 */
export function validateApiKey(): void {
  getApiKey();
}
