/**
 * File utilities for saving and loading images
 */

import * as fs from "fs/promises";
import * as path from "path";
import { FILE_EXTENSIONS, type OutputFormat } from "../constants.js";
import { type InputImage, McpError, ErrorType } from "../types.js";

/**
 * Generate a timestamp-based filename
 * Format: image-YYYY-MM-DD-HHmmss-SSS
 *
 * Milliseconds are included so that rapid successive generations (e.g.
 * num_images > 1 saved into a directory) do not collide on the same filename.
 */
export function generateTimestampFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const millis = String(now.getMilliseconds()).padStart(3, "0");

  return `image-${year}-${month}-${day}-${hours}${minutes}${seconds}-${millis}`;
}

/**
 * Check if a path is a directory
 */
async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path exists
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    throw new McpError(
      ErrorType.FILE_WRITE_ERROR,
      `Error: Could not create directory '${dirPath}'. Check permissions.`,
      error
    );
  }
}

/**
 * Resolve the output path for saving an image
 *
 * @param outputPath - User-provided path (file or directory)
 * @param format - Output format (jpeg, png or webp)
 * @param index - Image index for multiple images (0-based)
 * @returns Resolved absolute file path
 */
export async function resolveOutputPath(
  outputPath: string,
  format: OutputFormat,
  index: number = 0
): Promise<string> {
  // Expand home directory
  const expandedPath = outputPath.replace(/^~/, process.env.HOME || "");
  const absolutePath = path.resolve(expandedPath);

  const extension = FILE_EXTENSIONS[format];

  // Treat as a directory when the path already is one, OR when the user signals
  // directory intent with a trailing separator (path.resolve strips it, so we
  // check the original string). A directory that does not exist yet is created.
  const endsWithSeparator = /[\\/]$/.test(outputPath);
  if (endsWithSeparator || (await isDirectory(absolutePath))) {
    await ensureDirectory(absolutePath);
    // Generate filename in the directory
    const filename = `${generateTimestampFilename()}${index > 0 ? `-${index + 1}` : ""}${extension}`;
    return path.join(absolutePath, filename);
  }

  // Check if parent directory exists
  const parentDir = path.dirname(absolutePath);
  if (!(await pathExists(parentDir))) {
    // Try to create the parent directory
    await ensureDirectory(parentDir);
  }

  // If it's a file path. Any existing extension is replaced so the saved file
  // extension always matches the resolved output format.
  const ext = path.extname(absolutePath);
  const baseName = ext
    ? path.basename(absolutePath, ext)
    : path.basename(absolutePath);
  const suffix = index > 0 ? `-${index + 1}` : "";

  return path.join(parentDir, `${baseName}${suffix}${extension}`);
}

/**
 * Save base64-encoded image data to a file
 *
 * @param base64Data - Base64-encoded image data
 * @param outputPath - Resolved output file path
 * @returns Size of the saved file in bytes
 */
export async function saveBase64Image(
  base64Data: string,
  outputPath: string
): Promise<number> {
  try {
    // Decode base64 to buffer
    const buffer = Buffer.from(base64Data, "base64");

    // Write to file
    await fs.writeFile(outputPath, buffer);

    return buffer.length;
  } catch (error) {
    throw new McpError(
      ErrorType.FILE_WRITE_ERROR,
      `Error: Could not write to '${outputPath}'. Check that the directory exists and you have write permissions.`,
      error
    );
  }
}

/**
 * Reject an input image above the selected model's per-image limit.
 *
 * @param maxBytes - The model's `maxInputImageBytes` from the capability registry
 */
function assertWithinSizeLimit(
  buffer: Buffer,
  source: string,
  maxBytes: number
): void {
  if (buffer.length <= maxBytes) return;

  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
  throw new McpError(
    ErrorType.IMAGE_TOO_LARGE,
    `Error: Image at '${source}' is ${sizeMB}MB, above the ${maxBytes / (1024 * 1024)}MB limit for the selected model. Resize it, or choose a model with a larger input limit.`
  );
}

/**
 * Read an image file and convert to base64
 *
 * @param imagePath - Path to the image file
 * @param maxBytes - Maximum accepted size for the selected model
 * @returns InputImage with base64 data and mime type
 */
export async function readImageAsBase64(
  imagePath: string,
  maxBytes: number
): Promise<InputImage> {
  // Expand home directory
  const expandedPath = imagePath.replace(/^~/, process.env.HOME || "");
  const absolutePath = path.resolve(expandedPath);

  // Check if file exists
  if (!(await pathExists(absolutePath))) {
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Image file not found at '${imagePath}'. Ensure the path is correct and the file exists.`
    );
  }

  try {
    // Read file
    const buffer = await fs.readFile(absolutePath);

    assertWithinSizeLimit(buffer, imagePath, maxBytes);

    // Determine MIME type from extension
    const ext = path.extname(absolutePath).toLowerCase();
    const mimeType = getMimeTypeFromExtension(ext);

    // Convert to base64
    const base64Data = buffer.toString("base64");

    return {
      data: base64Data,
      mimeType,
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not read image file at '${imagePath}'. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if a string is a URL
 */
export function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetch an image from a URL and convert to base64
 *
 * @param imageUrl - URL of the image
 * @param maxBytes - Maximum accepted size for the selected model
 * @returns InputImage with base64 data and mime type
 */
export async function fetchImageAsBase64(
  imageUrl: string,
  maxBytes: number
): Promise<InputImage> {
  try {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new McpError(
        ErrorType.INVALID_IMAGE_PATH,
        `Error: Could not fetch image from '${imageUrl}'. Server returned status ${response.status}.`
      );
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    assertWithinSizeLimit(buffer, imageUrl, maxBytes);

    const base64Data = buffer.toString("base64");

    return {
      data: base64Data,
      mimeType: contentType,
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not fetch image from '${imageUrl}'. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load an image from a path or URL, within the selected model's size limit.
 */
export async function loadImage(
  pathOrUrl: string,
  maxBytes: number
): Promise<InputImage> {
  if (isUrl(pathOrUrl)) {
    return fetchImageAsBase64(pathOrUrl, maxBytes);
  }
  return readImageAsBase64(pathOrUrl, maxBytes);
}

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromExtension(ext: string): string {
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
  };

  return mimeMap[ext] || "image/png";
}
