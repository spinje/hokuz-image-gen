import { ErrorType, ToolError } from "../types.js";

// Shared by both tools and all server instances in this process. Reject rather
// than queue: waiting image calls must not accumulate input buffers in memory.
let active = false;

export function throwIfImageCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ToolError(ErrorType.REQUEST_CANCELLED, "Image request cancelled; no further images will be requested.", "Do not automatically retry a cancelled request.");
  }
}

export function acquireImageOperation(): () => void {
  if (active) {
    throw new ToolError(
      ErrorType.SERVER_BUSY,
      "This server is already processing an image call.",
      "Wait for the active call to finish before retrying."
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
