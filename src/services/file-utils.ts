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
import { throwIfImageCancelled } from "./image-operation.js";
import { fetchRemoteImage } from "./remote-image.js";
import { expandHomePath, resolveOutputDestination } from "./path-policy.js";

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

/** Output format per output-path extension, case-insensitive. */
const OUTPUT_FORMAT_BY_EXTENSION: Record<string, OutputFormat> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
};

/**
 * The output format an `output_path` asks for by its extension, or undefined
 * when its extension names none we produce (a directory path included).
 */
export function inferOutputFormatFromPath(
  outputPath: string
): OutputFormat | undefined {
  return OUTPUT_FORMAT_BY_EXTENSION[path.extname(outputPath).toLowerCase()];
}

/** Resolve directory intent and extension; only the exclusive write claims a name. */
async function outputTarget(outputPath: string, format: OutputFormat) {
  const absolutePath = await resolveOutputDestination(outputPath);
  const extension = FILE_EXTENSIONS[format];
  if (/[\\/]$/.test(outputPath) || await isDirectory(absolutePath)) {
    await ensureDirectory(absolutePath);
    return { dir: absolutePath, baseName: generateTimestampFilename(), extension };
  }
  const dir = path.dirname(absolutePath);
  await ensureDirectory(dir);
  return { dir, baseName: path.basename(absolutePath, path.extname(absolutePath)), extension };
}

const MAX_NAME_ATTEMPTS = 10_000;

/**
 * Claim and write one unused filename, returning the path actually saved.
 * Exclusive creation also protects against other server processes and dangling
 * symlinks. A collision retries the filename, never the paid provider request.
 */
export async function saveBase64Image(
  base64Data: string,
  outputPath: string,
  format: OutputFormat,
  index = 0
): Promise<string> {
  const { dir, baseName, extension } = await outputTarget(outputPath, format);
  const buffer = Buffer.from(base64Data, "base64");
  for (let n = index; n < index + MAX_NAME_ATTEMPTS; n++) {
    const candidate = path.join(dir, `${baseName}${n > 0 ? `-${n + 1}` : ""}${extension}`);
    try {
      await fs.writeFile(candidate, buffer, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw new McpError(
        ErrorType.FILE_WRITE_ERROR,
        `Error: Could not write to '${candidate}'. Check directory permissions and available disk space.`,
        error
      );
    }
  }
  throw new McpError(
    ErrorType.FILE_WRITE_ERROR,
    `Error: Could not find a free filename near '${baseName}${extension}' after ${MAX_NAME_ATTEMPTS} attempts. Choose a different output_path.`
  );
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
  model: ImageModel,
  signal?: AbortSignal
): Promise<InputImage> {
  throwIfImageCancelled(signal);
  try {
    return await (isUrl(pathOrUrl)
      ? fetchInputImage(pathOrUrl, model, signal)
      : readInputImage(pathOrUrl, model, signal));
  } catch (error) {
    throwIfImageCancelled(signal);
    throw error;
  }
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
  model: ImageModel,
  signal?: AbortSignal
): Promise<InputImage> {
  const absolutePath = path.resolve(expandHomePath(imagePath));

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
    const buffer = await fs.readFile(absolutePath, { signal });
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
  model: ImageModel,
  signal?: AbortSignal
): Promise<InputImage> {
  let response: Response;
  try {
    response = await fetchRemoteImage(imageUrl, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof McpError) throw error;
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `it did not respond within ${FETCH_TIMEOUT_MS / 1000} seconds`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new McpError(
      ErrorType.INVALID_IMAGE_PATH,
      `Error: Could not fetch image from '${imageUrl}': ${reason}. Check the URL, or download the image and pass a local path.`,
      undefined,
      // A timeout or a refused connection says nothing about the URL being
      // wrong, and INVALID_IMAGE_PATH is otherwise a "fix the arguments" type.
      { retryable: true }
    );
  }

  try {
    if (!response.ok) {
      throw new McpError(
        ErrorType.INVALID_IMAGE_PATH,
        `Error: Could not fetch image from '${imageUrl}'. Server returned status ${response.status}. Check the URL, or download the image and pass a local path.`,
        undefined,
        // The host failing or throttling is transient; a 4xx from it means the
        // URL really is wrong.
        { retryable: response.status >= 500 || response.status === 429 }
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
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
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

  try {
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
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
