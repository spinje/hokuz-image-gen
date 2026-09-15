/**
 * File utilities for saving and loading images
 */

import * as fs from "fs/promises";
import type { Stats } from "fs";
import * as path from "path";
import {
  FILE_EXTENSIONS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedInputImageMessage,
  type ImageModel,
  type OutputFormat,
} from "../constants.js";
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

/** Input MIME type per file extension. */
const INPUT_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const MB = 1024 * 1024;

/** How long to wait for a remote image before giving up. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Load one input image for an edit, from a local path or an http(s) URL.
 *
 * Checks run type -> allowlist -> size, so the bytes of an image the model
 * would reject, or one over its limit, are never read.
 */
export async function loadInputImage(
  pathOrUrl: string,
  model: ImageModel
): Promise<InputImage> {
  return isUrl(pathOrUrl)
    ? fetchInputImage(pathOrUrl, model)
    : readInputImage(pathOrUrl, model);
}

/** True for the schemes we fetch; anything else is treated as a file path. */
function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readInputImage(
  imagePath: string,
  model: ImageModel
): Promise<InputImage> {
  const absolutePath = path.resolve(
    imagePath.replace(/^~/, process.env.HOME || "")
  );

  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = INPUT_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw unknownTypeError(
      imagePath,
      model,
      `from its extension '${extension || "(none)"}'`
    );
  }
  assertModelAcceptsType(imagePath, mimeType, model);

  let stats: Stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Image file not found at '${imagePath}'. Ensure the path is correct and the file exists.`
    );
  }
  assertWithinSizeLimit(stats.size, imagePath, model);

  try {
    const buffer = await fs.readFile(absolutePath);
    return { data: buffer.toString("base64"), mimeType };
  } catch (error) {
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not read image file at '${imagePath}'. ${error instanceof Error ? error.message : String(error)}. Check the file's permissions.`
    );
  }
}

async function fetchInputImage(
  imageUrl: string,
  model: ImageModel
): Promise<InputImage> {
  let response: Response;
  try {
    response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `it did not respond within ${FETCH_TIMEOUT_MS / 1000} seconds`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not fetch image from '${imageUrl}': ${reason}. Check the URL, or download the image and pass a local path.`
    );
  }

  if (!response.ok) {
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not fetch image from '${imageUrl}'. Server returned status ${response.status}. Check the URL, or download the image and pass a local path.`
    );
  }

  // "image/jpeg; charset=utf-8" and "IMAGE/JPEG" are the same type as far as
  // the allowlist is concerned.
  const mimeType = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (!mimeType) {
    throw unknownTypeError(
      imageUrl,
      model,
      "because the server did not report a content-type"
    );
  }
  assertModelAcceptsType(imageUrl, mimeType, model);

  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > 0) {
    assertWithinSizeLimit(declaredLength, imageUrl, model);
  }

  const buffer = await readBodyWithinLimit(response, imageUrl, model);
  return { data: buffer.toString("base64"), mimeType };
}

/**
 * Read the body chunk by chunk and stop at the model's limit: a server that
 * omits or under-reports content-length must not be able to make us buffer an
 * unbounded body.
 */
async function readBodyWithinLimit(
  response: Response,
  source: string,
  model: ImageModel
): Promise<Buffer> {
  if (!response.body) {
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: The response from '${source}' carried no image data. Check the URL, or download the image and pass a local path.`
    );
  }

  const limit = IMAGE_MODEL_CAPABILITIES[model].maxInputImageBytes;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.length;
    if (received > limit) {
      await reader.cancel();
      assertWithinSizeLimit(received, source, model);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/**
 * The image type could not be established from metadata. Guessing here would
 * hide exactly the files the allowlist exists to catch.
 */
function unknownTypeError(
  source: string,
  model: ImageModel,
  clause: string
): McpError {
  const caps = IMAGE_MODEL_CAPABILITIES[model];
  const supported = caps.inputMimeTypes
    .map((mime) => mime.replace("image/", ""))
    .join(", ");

  return new McpError(
    ErrorType.INVALID_IMAGE_PATH,
    `Error: Cannot determine the image type of '${source}' ${clause}. Supported input formats for '${model}' (${caps.label}): ${supported}. Rename or convert the image.`
  );
}

function assertModelAcceptsType(
  source: string,
  mimeType: string,
  model: ImageModel
): void {
  const unsupported = getUnsupportedInputImageMessage({
    model,
    mimeType,
    path: source,
  });
  if (unsupported) {
    throw new McpError(ErrorType.INVALID_IMAGE_PATH, unsupported);
  }
}

function assertWithinSizeLimit(
  bytes: number,
  source: string,
  model: ImageModel
): void {
  const caps = IMAGE_MODEL_CAPABILITIES[model];
  if (bytes <= caps.maxInputImageBytes) return;

  const largestLimit = Math.max(
    ...Object.values(IMAGE_MODEL_CAPABILITIES).map(
      (candidate) => candidate.maxInputImageBytes
    )
  );
  const alternative =
    caps.maxInputImageBytes < largestLimit
      ? `, or use an OpenAI model (${largestLimit / MB}MB limit)`
      : "";

  throw new McpError(
    ErrorType.IMAGE_TOO_LARGE,
    `Error: Image at '${source}' is ${(bytes / MB).toFixed(2)}MB, above the ${caps.maxInputImageBytes / MB}MB limit for '${model}' (${caps.label}). Resize it${alternative}.`
  );
}
