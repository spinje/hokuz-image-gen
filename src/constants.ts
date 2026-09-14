/**
 * Constants for Nano Banana MCP Server
 */

/**
 * Supported image models (exact Gemini model IDs).
 *
 * These map to the "Nano Banana" family of image models and are called through
 * the Gemini Interactions API.
 */
export const IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
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
 * Maps a public resolution token to the API `image_size` value.
 * The Interactions API uses "512" rather than "0.5K".
 */
export const IMAGE_SIZE_API_VALUES: Record<Resolution, string> = {
  "0.5K": "512",
  "1K": "1K",
  "2K": "2K",
  "4K": "4K",
} as const;

/**
 * Supported output formats.
 *
 * Note: the Interactions API for these models produces JPEG only. Its
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
  temperature: 1.0,
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
  /** Fallback API key environment variable (accepted for compatibility) */
  googleApiKey: "GOOGLE_API_KEY",
  /** Preferred API key environment variable; checked first */
  geminiApiKey: "GEMINI_API_KEY",
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
  /** Resolutions the model supports */
  resolutions: readonly Resolution[];
  /** Aspect ratios the model supports */
  aspectRatios: readonly AspectRatio[];
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
 * Validation against this registry happens in-process before any Google API
 * request is made. Unsupported combinations are rejected rather than silently
 * downgraded.
 */
export const IMAGE_MODEL_CAPABILITIES: Record<ImageModel, ImageModelCapabilities> = {
  "gemini-3.1-flash-lite-image": {
    label: "Nano Banana 2 Lite",
    resolutions: ["1K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    supportsPdfInput: false,
    supportsSearchGrounding: false,
    supportsStructuredOutputs: false,
  },
  "gemini-3.1-flash-image": {
    label: "Nano Banana 2",
    resolutions: ["0.5K", "1K", "2K", "4K"],
    aspectRatios: ASPECT_RATIOS,
    supportsPdfInput: true,
    supportsSearchGrounding: true,
    supportsStructuredOutputs: false,
  },
  "gemini-3-pro-image": {
    label: "Nano Banana Pro",
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    supportsPdfInput: false,
    supportsSearchGrounding: true,
    supportsStructuredOutputs: true,
  },
};

/**
 * Pure validation helper. Returns a human-readable error message if the
 * model/resolution/aspect-ratio combination is unsupported, otherwise null.
 *
 * Kept free of McpError to avoid coupling constants to the error domain;
 * callers translate the message into an McpError.
 */
export function getUnsupportedModelOptionMessage(args: {
  model: ImageModel;
  resolution: Resolution;
  aspectRatio?: AspectRatio;
}): string | null {
  const caps = IMAGE_MODEL_CAPABILITIES[args.model];

  if (!caps.resolutions.includes(args.resolution)) {
    return `Error: Model '${args.model}' (${caps.label}) does not support resolution '${args.resolution}'. Supported resolutions: ${caps.resolutions.join(", ")}.`;
  }

  if (args.aspectRatio && !caps.aspectRatios.includes(args.aspectRatio)) {
    return `Error: Model '${args.model}' (${caps.label}) does not support aspect ratio '${args.aspectRatio}'. Supported aspect ratios: ${caps.aspectRatios.join(", ")}.`;
  }

  return null;
}
