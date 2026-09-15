import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LIMITS } from "../../constants.js";
import { ErrorType } from "../../types.js";
import { inferOutputFormatFromPath, loadImage, resolveOutputPath } from "../file-utils.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

const TIMESTAMPED = /^image-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}\.jpg$/;

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

  it("suffixes -2, -3 from the second image onward in file mode", async () => {
    const base = path.join(tmp, "foo.jpg");
    expect(await resolveOutputPath(base, "jpeg", 0)).toBe(path.join(tmp, "foo.jpg"));
    expect(await resolveOutputPath(base, "jpeg", 1)).toBe(path.join(tmp, "foo-2.jpg"));
    expect(await resolveOutputPath(base, "jpeg", 2)).toBe(path.join(tmp, "foo-3.jpg"));
  });

  it("suffixes the index in directory mode too, so same-millisecond images cannot collide", async () => {
    // num_images > 1 into a directory resolves each path within the same
    // millisecond in practice; the index suffix is the only thing keeping
    // them distinct.
    const first = path.basename(await resolveOutputPath(tmp, "jpeg", 0));
    const second = path.basename(await resolveOutputPath(tmp, "jpeg", 1));
    expect(first).toMatch(TIMESTAMPED);
    expect(second).toMatch(/^image-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-2\.jpg$/);
  });

  it("expands a leading ~ to HOME", async () => {
    vi.stubEnv("HOME", tmp);
    const resolved = await resolveOutputPath("~/pics/foo.jpg", "jpeg");
    expect(resolved).toBe(path.join(tmp, "pics", "foo.jpg"));
  });
});

describe("inferOutputFormatFromPath", () => {
  it("infers jpeg from .jpg and .jpeg case-insensitively, and nothing else", () => {
    expect(inferOutputFormatFromPath("a.jpg")).toBe("jpeg");
    expect(inferOutputFormatFromPath("a.JPEG")).toBe("jpeg");
    expect(inferOutputFormatFromPath("a.png")).toBeUndefined();
    expect(inferOutputFormatFromPath("a")).toBeUndefined();
  });
});

describe("loadImage", () => {
  it("rejects a local image over the size limit with IMAGE_TOO_LARGE", async () => {
    const big = path.join(tmp, "big.png");
    await fs.writeFile(big, Buffer.alloc(LIMITS.maxInputImageSize + 1));
    await expect(loadImage(big)).rejects.toThrowError(
      expect.objectContaining({ type: ErrorType.IMAGE_TOO_LARGE })
    );
  });

  it("accepts a local image exactly at the size limit", async () => {
    const edge = path.join(tmp, "edge.png");
    await fs.writeFile(edge, Buffer.alloc(LIMITS.maxInputImageSize));
    const image = await loadImage(edge);
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64")).toHaveLength(LIMITS.maxInputImageSize);
  });

  it("fetches http(s) URLs and takes the MIME type from the response header", async () => {
    const bytes = Buffer.from("remote-bytes");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/webp" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const image = await loadImage("https://example.com/pic.webp");

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/pic.webp");
    expect(image).toEqual({ data: bytes.toString("base64"), mimeType: "image/webp" });
  });

  it("reports a non-OK HTTP response as INVALID_IMAGE_PATH with the status code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));

    await expect(loadImage("https://example.com/missing.png")).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: expect.stringContaining("status 404"),
      })
    );
  });

  it("does not treat non-http schemes as URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadImage("file:///etc/hosts")).rejects.toThrowError(
      expect.objectContaining({ type: ErrorType.INVALID_IMAGE_PATH })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
