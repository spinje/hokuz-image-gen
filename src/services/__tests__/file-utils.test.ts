import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  inferOutputFormatFromPath,
  resolveOutputPath,
  resolveRequestedOutputFormat,
  saveBase64Image,
} from "../file-utils.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nanobanana-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const TIMESTAMPED = /^image-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}(-\d+)?\.jpg$/;

describe("resolveOutputPath", () => {
  it("treats an existing directory as a directory and generates a timestamped name", async () => {
    const resolved = await resolveOutputPath(tmp, "jpeg");
    expect(path.dirname(resolved)).toBe(tmp);
    expect(path.basename(resolved)).toMatch(TIMESTAMPED);
  });

  it("treats a trailing separator as a directory even when it does not exist yet", async () => {
    const dir = path.join(tmp, "new-dir");
    const resolved = await resolveOutputPath(`${dir}/`, "jpeg");
    expect(path.dirname(resolved)).toBe(dir);
    expect(path.basename(resolved)).toMatch(TIMESTAMPED);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("replaces a foreign extension with the output format's extension", async () => {
    const resolved = await resolveOutputPath(path.join(tmp, "foo.png"), "jpeg");
    expect(resolved).toBe(path.join(tmp, "foo.jpg"));
  });

  it("appends the extension when the file path has none", async () => {
    const resolved = await resolveOutputPath(path.join(tmp, "foo"), "jpeg");
    expect(resolved).toBe(path.join(tmp, "foo.jpg"));
  });

  it("creates a missing parent directory in file mode", async () => {
    const resolved = await resolveOutputPath(path.join(tmp, "a", "b", "foo.jpg"), "jpeg");
    expect(resolved).toBe(path.join(tmp, "a", "b", "foo.jpg"));
    expect((await fs.stat(path.join(tmp, "a", "b"))).isDirectory()).toBe(true);
  });

  it("suffixes -2, -3 from the second image onward", async () => {
    const base = path.join(tmp, "foo.jpg");
    expect(await resolveOutputPath(base, "jpeg", 0)).toBe(path.join(tmp, "foo.jpg"));
    expect(await resolveOutputPath(base, "jpeg", 1)).toBe(path.join(tmp, "foo-2.jpg"));
    expect(await resolveOutputPath(base, "jpeg", 2)).toBe(path.join(tmp, "foo-3.jpg"));
  });

  it("expands a leading ~ to HOME", async () => {
    vi.stubEnv("HOME", tmp);
    const resolved = await resolveOutputPath("~/pics/foo.jpg", "jpeg");
    expect(resolved).toBe(path.join(tmp, "pics", "foo.jpg"));
  });
});

describe("output format resolution", () => {
  it("infers jpeg from .jpg and .jpeg, case-insensitively", () => {
    expect(inferOutputFormatFromPath("a.jpg")).toBe("jpeg");
    expect(inferOutputFormatFromPath("a.JPEG")).toBe("jpeg");
  });

  it("returns undefined for extensions we do not produce", () => {
    expect(inferOutputFormatFromPath("a.png")).toBeUndefined();
    expect(inferOutputFormatFromPath("a")).toBeUndefined();
  });

  it("explicit format wins, then path extension, then the default", () => {
    expect(resolveRequestedOutputFormat("a.png", "jpeg")).toBe("jpeg");
    expect(resolveRequestedOutputFormat("a.jpg")).toBe("jpeg");
    expect(resolveRequestedOutputFormat("a.png")).toBe("jpeg");
    expect(resolveRequestedOutputFormat("dir/")).toBe("jpeg");
  });
});

describe("saveBase64Image", () => {
  it("decodes and writes the bytes, returning the byte length", async () => {
    const bytes = Buffer.from("not-really-a-jpeg");
    const target = path.join(tmp, "out.jpg");
    const size = await saveBase64Image(bytes.toString("base64"), target);
    expect(size).toBe(bytes.length);
    expect(await fs.readFile(target)).toEqual(bytes);
  });
});
