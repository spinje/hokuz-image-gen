/**
 * File utilities for saving and loading images
 */

import * as fs from "fs/promises";
import { constants as fsConstants, type Stats } from "fs";
import * as path from "path";
import {
  FILE_EXTENSIONS,
  LIMITS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedInputImage,
  type ImageModel,
  type OutputFormat,
} from "../constants.js";
import { type InputImage, ToolError, ErrorType } from "../types.js";
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
    throw new ToolError(
      ErrorType.FILE_WRITE_ERROR,
      `Could not create output directory '${dirPath}'.`,
      fileWriteRecovery(error), error
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
      throw new ToolError(
        ErrorType.FILE_WRITE_ERROR,
        `Could not save the image to '${candidate}'.`,
        fileWriteRecovery(error), error
      );
    }
  }
  throw new ToolError(
    ErrorType.FILE_WRITE_ERROR,
    `Could not find a free filename near '${baseName}${extension}'.`,
    "Choose a different output_path."
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
  signal?: AbortSignal,
  remainingBytes = LIMITS.maxTotalInputImageBytes
): Promise<InputImage> {
  throwIfImageCancelled(signal);
  try {
    return await (isUrl(pathOrUrl)
      ? fetchInputImage(pathOrUrl, model, signal, remainingBytes)
      : readInputImage(pathOrUrl, model, signal, remainingBytes));
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
  signal: AbortSignal | undefined,
  remainingBytes: number
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

  try {
    const stats = await fs.stat(absolutePath);
    assertRegularInput(stats, imagePath, model, remainingBytes);
    const buffer = await readLocalWithinLimit(absolutePath, model, signal, remainingBytes);
    return { data: buffer.toString("base64"), mimeType };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    switch (fileErrorCode(error)) {
      case "ENOENT":
        throw new ToolError(ErrorType.INVALID_IMAGE_PATH, `Image file not found at '${imagePath}'.`,
          "Correct image_paths to point to an existing image file.", error);
      case "EACCES": case "EPERM":
        throw new ToolError(ErrorType.INVALID_IMAGE_PATH, `Permission denied reading image '${imagePath}'.`,
          "Grant the server read access, or provide an accessible copy of the image.", error);
      case "ENOTDIR":
        throw new ToolError(ErrorType.INVALID_IMAGE_PATH, `A parent of '${imagePath}' is not a directory.`,
          "Correct the directory components in image_paths.", error);
      default:
        throw new ToolError(ErrorType.INVALID_IMAGE_PATH, `Could not read image '${imagePath}'.`,
          "Check that the file and its storage are accessible, or provide another readable copy.", error);
    }
  }
}

function fileErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function fileWriteRecovery(error: unknown): string {
  switch (fileErrorCode(error)) {
    case "EACCES": case "EPERM": return "Choose an output_path the server can write to, or correct directory permissions.";
    case "ENOSPC": case "EDQUOT": return "Free disk space or storage quota before requesting another image.";
    case "ENOTDIR": case "EISDIR": return "Correct output_path so its parent is a directory and its filename is not an existing directory.";
    default: return "Check the output directory's accessibility and available storage before requesting another image.";
  }
}

function assertRegularInput(stats: Stats, source: string, model: ImageModel, remainingBytes: number): void {
  if (!stats.isFile()) throw new ToolError(ErrorType.INVALID_IMAGE_PATH, `Input '${source}' must be a regular file.`, "Pass an image file, not a directory or special file.");
  assertWithinSizeLimit(stats.size, source, model, remainingBytes);
}

/** Cap the actual read too: a file can grow or be replaced after path stat. */
async function readLocalWithinLimit(source: string, model: ImageModel, signal: AbortSignal | undefined, remainingBytes: number): Promise<Buffer> {
  throwIfImageCancelled(signal);
  // NONBLOCK prevents a replacement FIFO from blocking open; fstat then rejects
  // non-files. Regular-file reads are bounded and cancellation checked per chunk.
  const handle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    assertRegularInput(await handle.stat(), source, model, remainingBytes);
    const limit = Math.min(IMAGE_MODEL_CAPABILITIES[model].maxInputImageBytes, remainingBytes);
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      throwIfImageCancelled(signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - received + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      received += bytesRead;
      assertWithinSizeLimit(received, source, model, remainingBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, received);
  } finally {
    await handle.close();
  }
}

async function fetchInputImage(
  imageUrl: string,
  model: ImageModel,
  signal: AbortSignal | undefined,
  remainingBytes: number
): Promise<InputImage> {
  let response: Response | undefined;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    response = await fetchRemoteImage(imageUrl, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new ToolError(ErrorType.INVALID_IMAGE_PATH,
        `Could not download image '${imageUrl}': the image host returned HTTP ${response.status}.`,
        response.status >= 500 || response.status === 429 || response.status === 408
          ? "Wait for the image host to recover before retrying, or download the image and pass a local path."
          : "Correct the image URL or its access settings, or download the image and pass a local path.");
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
      assertWithinSizeLimit(declaredLength, imageUrl, model, remainingBytes);
    }

    const buffer = await readBodyWithinLimit(response, imageUrl, model, remainingBytes);
    return { data: buffer.toString("base64"), mimeType };
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    if (error instanceof ToolError) throw error;
    const timedOut = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
    throw new ToolError(ErrorType.INVALID_IMAGE_PATH,
      timedOut
        ? `Image download from '${imageUrl}' did not finish within ${FETCH_TIMEOUT_MS / 1000} seconds.`
        : `Could not finish downloading image '${imageUrl}'.`,
      "Check that the URL is accessible and serves an image, then retry, or download the image and pass a local path.", error);
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
  model: ImageModel,
  remainingBytes: number
): Promise<Buffer> {
  if (!response.body) {
    throw new ToolError(
      ErrorType.INVALID_IMAGE_PATH,
      `The response from '${source}' carried no image data.`,
      "Use a direct image URL, or download the image and pass a local path."
    );
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.length;
      assertWithinSizeLimit(received, source, model, remainingBytes);
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
): ToolError {
  const caps = IMAGE_MODEL_CAPABILITIES[model];
  const supported = caps.inputMimeTypes
    .map((mime) => mime.replace("image/", ""))
    .join(", ");

  return new ToolError(
    ErrorType.INVALID_IMAGE_PATH,
    `Cannot determine the image type of '${source}' ${clause}.`,
    isUrl(source)
      ? `Use a direct image URL with an image content-type header, or pass a local file in one of these formats: ${supported}.`
      : `Use the correct file extension for its actual format, or convert the image to one of: ${supported}.`
  );
}

function assertModelAcceptsType(
  source: string,
  mimeType: string,
  model: ImageModel
): void {
  const unsupported = getUnsupportedInputImage({
    model,
    mimeType,
    path: source,
  });
  if (unsupported) {
    throw new ToolError(ErrorType.INVALID_IMAGE_PATH, unsupported.message, unsupported.next_step);
  }
}

function assertWithinSizeLimit(
  bytes: number,
  source: string,
  model: ImageModel,
  remainingBytes: number
): void {
  const caps = IMAGE_MODEL_CAPABILITIES[model];
  if (bytes <= caps.maxInputImageBytes) {
    if (bytes > remainingBytes) {
      throw new ToolError(
        ErrorType.IMAGE_TOO_LARGE,
        `Image '${source}' needs at least ${bytes} bytes, exceeding the remaining combined input budget of ${remainingBytes} bytes (${LIMITS.maxTotalInputImageBytes / MB} MiB total).`,
        "Reduce the total size or number of reference images."
      );
    }
    return;
  }

  const largestLimit = Math.max(
    ...Object.values(IMAGE_MODEL_CAPABILITIES).map(
      (candidate) => candidate.maxInputImageBytes
    )
  );
  const alternative =
    caps.maxInputImageBytes < largestLimit
      ? `, or use an OpenAI model (${largestLimit / MB}MB limit)`
      : "";

  throw new ToolError(
    ErrorType.IMAGE_TOO_LARGE,
    `Image at '${source}' is ${(bytes / MB).toFixed(2)}MB, above the ${caps.maxInputImageBytes / MB}MB limit for '${model}' (${caps.label}).`,
    `Resize or compress it${alternative}.`
  );
}
