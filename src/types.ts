/**
 * Type definitions for Nano Banana MCP Server
 */

import type { AspectRatio, Resolution, OutputFormat } from "./constants.js";

/**
 * Configuration for image generation requests
 */
export interface ImageGenerationConfig {
  /** Aspect ratio for the generated image */
  aspectRatio: AspectRatio;
  /** Resolution/quality setting */
  resolution: Resolution;
  /** Temperature for creativity (0.0-2.0) */
  temperature: number;
}

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
 * Result of saving an image to disk
 */
export interface SavedImageResult {
  /** Full path where the image was saved */
  path: string;
  /** Output format used */
  format: OutputFormat;
  /** Size in bytes */
  size: number;
}

/**
 * Output structure for generate_image tool
 */
export interface GenerateImageOutput {
  /** Whether the operation succeeded */
  success: boolean;
  /** Array of generated image results */
  images: Array<{
    /** File path if saved to disk */
    path?: string;
    /** Base64 data URL if not saved to disk */
    dataUrl?: string;
    /** Image format */
    format: string;
  }>;
  /** Model's text description of the generated image(s) */
  description?: string;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Output structure for edit_image tool
 */
export interface EditImageOutput {
  /** Whether the operation succeeded */
  success: boolean;
  /** Array of edited image results */
  images: Array<{
    /** File path if saved to disk */
    path?: string;
    /** Base64 data URL if not saved to disk */
    dataUrl?: string;
    /** Image format */
    format: string;
  }>;
  /** Model's text description of the edited image(s) */
  description?: string;
  /** Error message if operation failed */
  error?: string;
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
  TOO_MANY_IMAGES = "TOO_MANY_IMAGES",
  API_RATE_LIMIT = "API_RATE_LIMIT",
  CONTENT_BLOCKED = "CONTENT_BLOCKED",
  FILE_WRITE_ERROR = "FILE_WRITE_ERROR",
  API_ERROR = "API_ERROR",
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
