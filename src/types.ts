/**
 * Type definitions for Nano Banana MCP Server
 */

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
 * Response from the Gemini API for image generation
 */
export interface GeminiImageResponse {
  /** Array of generated images */
  images: GeneratedImage[];
  /** Text description from the model (if any) */
  description?: string;
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
