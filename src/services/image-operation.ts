import { ErrorType, McpError } from "../types.js";

// Shared by both tools and all server instances in this process. Reject rather
// than queue: waiting image calls must not accumulate input buffers in memory.
let active = false;

export function throwIfImageCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new McpError(ErrorType.REQUEST_CANCELLED, "Error: Image request cancelled; no further images will be requested.");
  }
}

export function acquireImageOperation(): () => void {
  if (active) {
    throw new McpError(
      ErrorType.SERVER_BUSY,
      "Error: This server is already processing an image call. Wait for it to finish before retrying."
    );
  }
  active = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active = false;
    }
  };
}
