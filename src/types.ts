/**
 * Type definitions for the image server
 */

import type {
  AspectRatio,
  ImageModel,
  OutputFormat,
  Quality,
  Resolution,
} from "./constants.js";

/**
 * A single generated image result
 */
export interface GeneratedImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type of the image */
  mimeType: string;
  /** Width in pixels (if available) */
  width?: number;
  /** Height in pixels (if available) */
  height?: number;
}

/**
 * Token usage and estimated cost for one provider request.
 *
 * Only providers that report token counts populate this (OpenAI); the cost is
 * derived from those counts and the hand-maintained price table, so it is an
 * estimate, not a billed amount.
 */
export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Configuration for a single image generation/edit request.
 *
 * Note: `numImages` is intentionally NOT part of this config. Requesting
 * multiple images is handled in the tool layer by making repeated independent
 * requests, so a provider is always "one request returns whatever it returns".
 */
export interface GenerationConfig {
  model: ImageModel;
  /** Omitted (undefined) means "auto" — let the model choose the ratio. */
  aspectRatio?: AspectRatio;
  /** Omitted (undefined) means the provider applies DEFAULTS.resolution. */
  resolution?: Resolution;
  outputFormat: OutputFormat;
  /** Gemini only; undefined on models that do not accept it. */
  temperature?: number;
  /** OpenAI only; undefined on models that do not accept it. */
  quality?: Quality;
  /** OpenAI only; needs an outputFormat with an alpha channel. */
  transparentBackground?: boolean;
}

/**
 * Result of one provider request
 */
export interface ImageResponse {
  /** Array of generated images */
  images: GeneratedImage[];
  /** Text description from the model (if any) */
  description?: string;
  /** Token usage, when the provider reports it */
  usage?: UsageReport;
}

/**
 * Input image for editing operations
 */
export interface InputImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type of the image */
  mimeType: string;
}

/**
 * Error types for better error handling
 */
export enum ErrorType {
  MISSING_API_KEY = "MISSING_API_KEY",
  INVALID_IMAGE_PATH = "INVALID_IMAGE_PATH",
  IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE",
  API_RATE_LIMIT = "API_RATE_LIMIT",
  CONTENT_BLOCKED = "CONTENT_BLOCKED",
  FILE_WRITE_ERROR = "FILE_WRITE_ERROR",
  API_ERROR = "API_ERROR",
  INVALID_MODEL_OPTION = "INVALID_MODEL_OPTION",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Custom error class for MCP operations
 */
export class McpError extends Error {
  constructor(
    public readonly type: ErrorType,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "McpError";
  }
}
