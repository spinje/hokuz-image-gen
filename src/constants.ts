/**
 * Constants for Nano Banana MCP Server
 */

/** Gemini model identifier for Nano Banana Pro */
export const MODEL_ID = "gemini-3-pro-image-preview";

/** Supported aspect ratios for image generation */
export const ASPECT_RATIOS = [
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

/** Aspect ratio type */
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Supported resolutions */
export const RESOLUTIONS = ["1K", "2K", "4K"] as const;

/** Resolution type */
export type Resolution = (typeof RESOLUTIONS)[number];

/** Supported output formats */
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

/** Output format type */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Default values for optional parameters */
export const DEFAULTS = {
  aspectRatio: "1:1" as AspectRatio,
  resolution: "1K" as Resolution,
  outputFormat: "png" as OutputFormat,
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
  /** Primary API key environment variable */
  googleApiKey: "GOOGLE_API_KEY",
  /** Fallback API key environment variable */
  geminiApiKey: "GEMINI_API_KEY",
} as const;

/** MIME types for output formats */
export const MIME_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

/** File extensions for output formats */
export const FILE_EXTENSIONS: Record<OutputFormat, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
} as const;

/**
 * Safety settings configured to minimum restrictions.
 * All categories set to BLOCK_NONE for maximum creative freedom.
 */
export const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
] as const;
