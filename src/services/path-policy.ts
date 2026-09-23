import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ErrorType, McpError } from "../types.js";
import { ENV_VARS } from "../constants.js";

/** Expand only the current user's home, never ~otheruser or a missing HOME to /. */
export function expandHomePath(value: string): string {
  return value.replace(/^~(?=$|\/)/, process.env.HOME || os.homedir());
}

async function canonicalDestination(destination: string): Promise<string> {
  let ancestor = destination;
  const missing: string[] = [];
  for (;;) {
    try {
      await fs.lstat(ancestor);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor)); ancestor = parent;
      continue;
    }
    // A dangling symlink must fail here, not be treated as a missing directory.
    const canonical = await fs.realpath(ancestor);
    if (missing.length && !(await fs.stat(canonical)).isDirectory()) {
      throw new Error("An output parent is not a directory");
    }
    return path.join(canonical, ...missing);
  }
}

/**
 * Validate before provider work and again before saving. This is an application
 * path policy, not an OS sandbox against another process replacing directories
 * after the checks. Other tools/processes need their own filesystem sandbox.
 */
export async function resolveOutputDestination(outputPath: string): Promise<string> {
  if (outputPath.includes("\0")) throw new McpError(ErrorType.FILE_WRITE_ERROR, "Error: output_path contains a null byte.");
  const expanded = expandHomePath(outputPath);
  const configured = process.env[ENV_VARS.outputRoot];
  if (configured === undefined) return path.resolve(expanded);
  try {
    const rootPath = expandHomePath(configured);
    if (!configured.trim() || !path.isAbsolute(rootPath)) throw new Error("HOKUZ_OUTPUT_ROOT must be an absolute directory path");
    const root = await fs.realpath(rootPath);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("HOKUZ_OUTPUT_ROOT must be an existing directory");
    const absolute = path.resolve(root, expanded);
    const canonical = await canonicalDestination(absolute);
    const relative = path.relative(root, canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("output_path is outside HOKUZ_OUTPUT_ROOT (including its symlink target)");
    }
    return absolute;
  } catch (error) {
    throw new McpError(
      ErrorType.FILE_WRITE_ERROR,
      `Error: Output path rejected. Use a path within the existing HOKUZ_OUTPUT_ROOT directory. ${error instanceof Error ? error.message : "Check the output root configuration."}`
    );
  }
}
