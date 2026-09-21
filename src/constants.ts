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
 * Supported output formats. Which of them a given model can produce is the
 * registry's `outputFormats` axis.
 */
export const OUTPUT_FORMATS = ["jpeg", "png", "webp"] as const;

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
  /**
   * Schema bound for the number of input images: the largest limit any model
   * has. The per-model limit is `maxInputImages` in the registry.
   */
  maxInputImages: 16,
  /** Minimum temperature */
  minTemperature: 0.0,
  /** Maximum temperature */
  maxTemperature: 2.0,
} as const;

/** Environment variable names for configuration */
export const ENV_VARS = {
  /** Optional output directory policy; relative output paths use this root. */
  outputRoot: "HOKUZ_OUTPUT_ROOT",
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

/**
 * Gemini image output price in USD per image, by model and resolution.
 * Hand-maintained from https://ai.google.dev/gemini-api/docs/pricing (Standard
 * tier) and cited in the README; the only input to a Gemini result's estimated
 * cost. Input and text tokens (a fraction of a cent) are deliberately not priced.
 *
 * Token counts cannot stand in for this: the API reports the same 1120 output
 * image tokens for a Flash 0.5K and a Flash 1K image, which are priced apart.
 */
export const GEMINI_PRICE_PER_IMAGE_USD: Partial<
  Record<ImageModel, Partial<Record<Resolution, number>>>
> = {
  "gemini-3.1-flash-lite-image": { "1K": 0.0336 },
  "gemini-3.1-flash-image": { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
};

/** MIME types for output formats */
export const MIME_TYPES: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

/** File extensions for output formats */
export const FILE_EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
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
  /** Output formats the model can produce */
  outputFormats: readonly OutputFormat[];
  /** Quality levels the model accepts; empty means the option is rejected */
  qualities: readonly Quality[];
  /** Whether the model accepts a temperature */
  supportsTemperature: boolean;
  /** Whether the model can render a transparent background */
  supportsTransparentBackground: boolean;
  /** Maximum number of input images the model accepts in one edit */
  maxInputImages: number;
  /** Maximum size of a single input image, in bytes */
  maxInputImageBytes: number;
  /** MIME types the model accepts as edit input */
  inputMimeTypes: readonly string[];
}

const MB = 1024 * 1024;

/** Gemini also accepts the formats OpenAI rejects (GIF, HEIC/HEIF). */
const GEMINI_INPUT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;

const OPENAI_INPUT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

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
    outputFormats: ["jpeg"],
    qualities: [],
    supportsTemperature: true,
    supportsTransparentBackground: false,
    maxInputImages: 14,
    maxInputImageBytes: 7 * MB,
    inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
  },
  "gemini-3.1-flash-image": {
    label: "Nano Banana 2",
    provider: "google",
    resolutions: ["0.5K", "1K", "2K", "4K"],
    aspectRatios: ASPECT_RATIOS,
    outputFormats: ["jpeg"],
    qualities: [],
    supportsTemperature: true,
    supportsTransparentBackground: false,
    maxInputImages: 14,
    maxInputImageBytes: 7 * MB,
    inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
  },
  "gemini-3-pro-image": {
    label: "Nano Banana Pro",
    provider: "google",
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    outputFormats: ["jpeg"],
    qualities: [],
    supportsTemperature: true,
    supportsTransparentBackground: false,
    maxInputImages: 14,
    maxInputImageBytes: 7 * MB,
    inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
  },
  "gpt-image-2.5-flare": {
    label: "GPT Image 2.5 Flare",
    provider: "openai",
    resolutions: ["1K", "2K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    outputFormats: OUTPUT_FORMATS,
    qualities: QUALITIES,
    supportsTemperature: false,
    supportsTransparentBackground: true,
    maxInputImages: 16,
    maxInputImageBytes: 50 * MB,
    inputMimeTypes: OPENAI_INPUT_MIME_TYPES,
  },
  "gpt-image-2.5-sunburst": {
    label: "GPT Image 2.5 Sunburst",
    provider: "openai",
    resolutions: ["1K", "2K"],
    aspectRatios: BASE_ASPECT_RATIOS,
    outputFormats: OUTPUT_FORMATS,
    qualities: QUALITIES,
    supportsTemperature: false,
    supportsTransparentBackground: true,
    maxInputImages: 16,
    maxInputImageBytes: 50 * MB,
    inputMimeTypes: OPENAI_INPUT_MIME_TYPES,
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
  outputFormat?: OutputFormat;
  quality?: Quality;
  temperature?: number;
  transparentBackground?: boolean;
  /** Number of images an edit is about to send; omitted by generate. */
  inputImageCount?: number;
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

  if (args.outputFormat !== undefined && !caps.outputFormats.includes(args.outputFormat)) {
    return `Error: ${who} does not support output_format '${args.outputFormat}'. Supported: ${caps.outputFormats.join(", ")}. Gemini models produce jpeg only; use gpt-image-2.5-flare or gpt-image-2.5-sunburst for png/webp.`;
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

  // Only `true` asks for something a model may not be able to do; `false` is
  // what every model does anyway.
  if (args.transparentBackground) {
    if (!caps.supportsTransparentBackground) {
      return `Error: ${who} does not support transparent_background. Use gpt-image-2.5-flare or gpt-image-2.5-sunburst with output_format png or webp.`;
    }
    if (args.outputFormat === "jpeg") {
      return "Error: transparent_background requires output_format 'png' or 'webp' (JPEG has no alpha channel). Set output_format accordingly, or omit transparent_background.";
    }
  }

  if (args.inputImageCount !== undefined && args.inputImageCount > caps.maxInputImages) {
    const alternative =
      caps.maxInputImages < LIMITS.maxInputImages
        ? `, or use an OpenAI model (up to ${LIMITS.maxInputImages})`
        : "";
    return `Error: ${who} accepts at most ${caps.maxInputImages} input images; ${args.inputImageCount} were given. Remove images${alternative}.`;
  }

  return null;
}

/**
 * Pure validation helper for one loaded input image. The MIME type is only
 * known once the image has been read, so this runs per image in the edit tool
 * rather than in `getUnsupportedModelOptionMessage`.
 */
export function getUnsupportedInputImageMessage(args: {
  model: ImageModel;
  mimeType: string;
  path: string;
}): string | null {
  const caps = IMAGE_MODEL_CAPABILITIES[args.model];
  if (caps.inputMimeTypes.includes(args.mimeType)) {
    return null;
  }

  const supported = caps.inputMimeTypes.map((mime) => mime.replace("image/", "")).join(", ");
  const alternative = caps.provider === "openai" ? ", or use a Gemini model" : "";
  return `Error: Model '${args.model}' (${caps.label}) does not accept ${args.mimeType} input ('${args.path}'). Supported input formats: ${supported}. Convert the image${alternative}.`;
}
