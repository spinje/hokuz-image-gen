import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ErrorType, ToolError } from "../types.js";
import { ENV_VARS } from "../constants.js";

/** Expand only the current user's home, never ~otheruser or a missing HOME to /. */
export function expandHomePath(value: string): string {
  return value.replace(/^~(?=$|\/)/, process.env.HOME || os.homedir());
}

async function canonicalDestination(destination: string, requireDirectory = false): Promise<string> {
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
    if ((missing.length || requireDirectory) && !(await fs.stat(canonical)).isDirectory()) {
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
  if (outputPath.includes("\0")) throw new ToolError(ErrorType.FILE_WRITE_ERROR, "output_path contains a null byte.", "Remove the null byte from output_path.");
  const expanded = expandHomePath(outputPath);
  const configured = process.env[ENV_VARS.outputRoot];
  if (configured === undefined) {
    const absolute = path.resolve(expanded);
    // Validate directory intent, not a filename that exclusive creation can suffix.
    const directory = /[\\/]$/.test(outputPath) ? absolute : path.dirname(absolute);
    try {
      await canonicalDestination(directory, true);
    } catch (error) {
      throw new ToolError(ErrorType.FILE_WRITE_ERROR,
        `Could not resolve an output directory for '${outputPath}'.`,
        "Choose an output_path whose existing directory components are accessible directories with valid symlink targets.", error);
    }
    return absolute;
  }
  let root: string;
  try {
    const rootPath = expandHomePath(configured);
    if (!configured.trim() || !path.isAbsolute(rootPath)) throw new Error("Invalid root");
    root = await fs.realpath(rootPath);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Not a directory");
  } catch (error) {
    throw new ToolError(ErrorType.FILE_WRITE_ERROR,
      "The server's HOKUZ_OUTPUT_ROOT configuration is not an accessible absolute directory.",
      "Have the server operator set HOKUZ_OUTPUT_ROOT to an existing, accessible absolute directory.", error);
  }
  const absolute = path.resolve(root, expanded);
  let canonical: string;
  try {
    canonical = await canonicalDestination(absolute, /[\\/]$/.test(outputPath));
  } catch (error) {
    throw new ToolError(ErrorType.FILE_WRITE_ERROR,
      `Could not resolve output_path '${outputPath}' within '${root}'.`,
      `Use a path within '${root}' whose existing parent directories are accessible and whose symlinks have valid targets.`, error);
  }
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToolError(ErrorType.FILE_WRITE_ERROR,
      `output_path '${outputPath}' resolves outside the allowed directory '${root}'.`,
      `Choose output_path within '${root}'; symlink targets must also stay inside that directory.`);
  }
  return absolute;
}
