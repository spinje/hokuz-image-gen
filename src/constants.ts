/**
 * Constants for the image server
 */

/** Model providers this server can call. */
export type Provider = "google" | "openai";

/**
 * Supported image models (exact provider model IDs).
 *
 * The Gemini IDs map to the "Nano Banana" family and are called through the
 * Gemini Interactions API; the OpenAI IDs are GPT Image 2.5 models called
 * through the Images API.
 */
export const IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

/** Image model type */
export type ImageModel = (typeof IMAGE_MODELS)[number];

/** Default image model (cost-conscious, current generalist) */
export const DEFAULT_IMAGE_MODEL: ImageModel = "gemini-3.1-flash-image";

/**
 * Base aspect ratios supported by all image models.
 */
export const BASE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

/**
 * Extra extreme aspect ratios supported only by gemini-3.1-flash-image.
 */
export const FLASH_EXTRA_ASPECT_RATIOS = ["1:4", "4:1", "1:8", "8:1"] as const;

/**
 * All aspect ratios exposed in the public schema. Model-specific validation
 * rejects combinations a given model does not support.
 */
export const ASPECT_RATIOS = [
  ...BASE_ASPECT_RATIOS,
  ...FLASH_EXTRA_ASPECT_RATIOS,
] as const;

/** Aspect ratio type */
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/**
 * Supported resolutions (public tokens). Model-specific validation rejects
 * unsupported model/resolution combinations.
 */
export const RESOLUTIONS = ["0.5K", "1K", "2K", "4K"] as const;

/** Resolution type */
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * OpenAI quality ladder. Cost and latency rise steeply across it; the schema
 * `.describe()` string carries the numbers a caller needs to choose.
 *
 * "auto" is deliberately not exposed: its cost is not knowable in advance.
 */
export const QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;

/** Quality type */
export type Quality = (typeof QUALITIES)[number];

/**
 * Supported output formats.
 *
 * Note: the Gemini Interactions API for these models produces JPEG only. Its
 * `response_format.mime_type` accepts only "image/jpeg" (PNG and WebP are not
 * supported), so JPEG is the sole output format.
 */
export const OUTPUT_FORMATS = ["jpeg"] as const;

/** Output format type */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Default values for optional parameters */
export const DEFAULTS = {
  model: DEFAULT_IMAGE_MODEL,
  aspectRatio: "1:1" as AspectRatio,
  resolution: "1K" as Resolution,
  outputFormat: "jpeg" as OutputFormat,
  numImages: 1,
  /** Applied by the Gemini provider when the config carries no temperature. */
  temperature: 1.0,
  /** Applied by the OpenAI provider when the config carries no quality. */
  quality: "medium" as Quality,
} as const;

/** API and input limits */
export const LIMITS = {
  /** Maximum prompt length in characters */
  maxPromptLength: 50000,
  /** Maximum number of images to generate per request */
  maxOutputImages: 4,
  /** Maximum number of input images for editing */
  maxInputImages: 14,
  /** Maximum input image size in bytes (7MB) */
  maxInputImageSize: 7 * 1024 * 1024,
  /** Minimum temperature */
  minTemperature: 0.0,
  /** Maximum temperature */
  maxTemperature: 2.0,
} as const;

/** Environment variable names for configuration */
export const ENV_VARS = {
  /** Fallback Gemini API key environment variable (accepted for compatibility) */
  googleApiKey: "GOOGLE_API_KEY",
  /** Preferred Gemini API key environment variable; checked first */
  geminiApiKey: "GEMINI_API_KEY",
  /** OpenAI API key environment variable */
  openaiApiKey: "OPENAI_API_KEY",
} as const;

/**
 * OpenAI image token prices in USD per million tokens. Hand-maintained from
 * https://developers.openai.com/api/docs/pricing and cited in the README;
 * used only to turn the reported token counts into an estimated cost.
 */
export const OPENAI_PRICE_PER_MILLION_TOKENS = {
  textInput: 5,
  imageInput: 8,
  imageOutput: 30,
} as const;

/** MIME types for output formats */
export const MIME_TYPES: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
} as const;

/** File extensions for output formats */
export const FILE_EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: ".jpg",
} as const;

/**
 * Capability metadata for a single image model.
 */
export interface ImageModelCapabilities {
  /** Human-friendly marketing name */
  label: string;
  /** Which provider module handles this model */
  provider: Provider;
  /** Resolutions the model supports */
  resolutions: readonly Resolution[];
  /** Aspect ratios the model supports */
  aspectRatios: readonly AspectRatio[];
  /** Quality levels the model accepts; empty means the option is rejected */
  qualities: readonly Quality[];
  /** Whether the model accepts a temperature */
  supportsTemperature: boolean;
  /** Whether the model accepts PDF input (metadata only; not implemented) */
  supportsPdfInput: boolean;
  /** Whether the model supports search grounding (metadata only) */
  supportsSearchGrounding: boolean;
  /** Whether the model supports structured outputs (metadata only) */
  supportsStructuredOutputs: boolean;
}

/**
 * Capability registry keyed by exact model ID.
 *
 * Validation against this registry happens in-process before any provider API
 * request is made. Unsupported combinations are rejected rather than silently
 * downgraded.
 */
export const IMAGE_MODEL_CAPABILITIES: Record<ImageModel, ImageModelCapabilities> = {
  "gemini-3.1-flash-lite-image": {
    label: "Nano Banana 2 Lite",
    provider: "google",
    resolutions: ["1K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    qualities: [],
    supportsTemperature: true,
    supportsPdfInput: false,
    supportsSearchGrounding: false,
    supportsStructuredOutputs: false,
  },
  "gemini-3.1-flash-image": {
    label: "Nano Banana 2",
    provider: "google",
    resolutions: ["0.5K", "1K", "2K", "4K"],
    aspectRatios: ASPECT_RATIOS,
    qualities: [],
    supportsTemperature: true,
    supportsPdfInput: true,
    supportsSearchGrounding: true,
    supportsStructuredOutputs: false,
  },
  "gemini-3-pro-image": {
    label: "Nano Banana Pro",
    provider: "google",
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    qualities: [],
    supportsTemperature: true,
    supportsPdfInput: false,
    supportsSearchGrounding: true,
    supportsStructuredOutputs: true,
  },
  "gpt-image-2.5-flare": {
    label: "GPT Image 2.5 Flare",
    provider: "openai",
    resolutions: ["1K", "2K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    qualities: QUALITIES,
    supportsTemperature: false,
    supportsPdfInput: false,
    supportsSearchGrounding: false,
    supportsStructuredOutputs: false,
  },
  "gpt-image-2.5-sunburst": {
    label: "GPT Image 2.5 Sunburst",
    provider: "openai",
    resolutions: ["1K", "2K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    qualities: QUALITIES,
    supportsTemperature: false,
    supportsPdfInput: false,
    supportsSearchGrounding: false,
    supportsStructuredOutputs: false,
  },
};

/**
 * Pure validation helper. Returns a human-readable error message if the
 * combination of options is unsupported by the model, otherwise null.
 *
 * Kept free of McpError to avoid coupling constants to the error domain;
 * callers translate the message into an McpError.
 */
export function getUnsupportedModelOptionMessage(args: {
  model: ImageModel;
  /** Undefined means "not asked for"; the provider applies its own default. */
  resolution?: Resolution;
  aspectRatio?: AspectRatio;
  quality?: Quality;
  temperature?: number;
}): string | null {
  const caps = IMAGE_MODEL_CAPABILITIES[args.model];
  const who = `Model '${args.model}' (${caps.label})`;

  if (args.resolution !== undefined && !caps.resolutions.includes(args.resolution)) {
    return `Error: ${who} does not support resolution '${args.resolution}'. Supported resolutions: ${caps.resolutions.join(", ")}. Choose one of those, or a model that supports '${args.resolution}'.`;
  }

  if (args.aspectRatio && !caps.aspectRatios.includes(args.aspectRatio)) {
    return `Error: ${who} does not support aspect ratio '${args.aspectRatio}'. Supported aspect ratios: ${caps.aspectRatios.join(", ")}. Choose one of those, or a model that supports '${args.aspectRatio}'.`;
  }

  // OpenAI derives the pixel size from the aspect ratio; without one it sends
  // size: "auto" and the resolution could not be applied, so say so instead.
  if (
    caps.provider === "openai" &&
    args.aspectRatio === undefined &&
    args.resolution !== undefined
  ) {
    return `Error: ${who} cannot apply resolution '${args.resolution}' when aspect_ratio is 'auto' because the provider chooses the output size. Set an aspect_ratio to control the size, or omit resolution.`;
  }

  if (args.quality !== undefined && !caps.qualities.includes(args.quality)) {
    if (caps.qualities.length === 0) {
      return `Error: ${who} does not accept 'quality'; it is an OpenAI-only option. Omit it, or use gpt-image-2.5-flare / gpt-image-2.5-sunburst.`;
    }
    return `Error: ${who} does not support quality '${args.quality}'. Supported qualities: ${caps.qualities.join(", ")}.`;
  }

  if (args.temperature !== undefined && !caps.supportsTemperature) {
    return `Error: ${who} does not accept 'temperature'; it is a Gemini-only option. Omit it, or use a gemini-* model.`;
  }

  return null;
}
