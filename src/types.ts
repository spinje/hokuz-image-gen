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

/** How an `estimatedCostUsd` was arrived at. */
export type CostBasis = "tokens" | "per_image";

/**
 * The estimated cost of one provider request, with whatever token counts came
 * with it.
 *
 * A report exists whenever the cost is known, never a billed amount; the counts
 * are the optional part, because a provider can price a request without
 * reporting them. `costBasis` says which of the two the cost came from:
 * "tokens" — arithmetic over the counts below and OPENAI_PRICE_PER_MILLION_TOKENS;
 * "per_image" — GEMINI_PRICE_PER_IMAGE_USD for the model and resolution, which
 * the counts below did not determine.
 */
export interface UsageReport {
  /** Reported by the provider; absent when it reported none. */
  inputTokens?: number;
  outputTokens?: number;
  /** Always present: a report exists only when the cost is known. */
  estimatedCostUsd: number;
  costBasis: CostBasis;
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
  /** Omitted uses DEFAULTS.resolution except OpenAI auto, where the provider chooses size. */
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
  /** A completed response that cannot be used (for example, an unexpected format). */
  issue?: ToolIssue;
  /** Array of generated images; may be empty even when the provider responded. */
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
  SERVER_BUSY = "SERVER_BUSY",
  REQUEST_CANCELLED = "REQUEST_CANCELLED",
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

/** The public explanation of a failure, shared by text and structured replies. */
export interface ToolIssue {
  code: ErrorType;
  message: string;
  next_step: string;
}

/** Expected application failure. The original cause is never sent to clients. */
export class ToolError extends Error {
  public readonly issue: ToolIssue;

  constructor(code: ErrorType, message: string, nextStep: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ToolError";
    this.issue = { code, message, next_step: nextStep };
  }
}
