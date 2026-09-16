import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FILE_EXTENSIONS, OUTPUT_FORMATS } from "../../constants.js";
import { ErrorType } from "../../types.js";

// The loader must reject a file on its metadata alone; `readFile` staying
// uncalled is how the tests below observe that.
const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  readFileSpy.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileSpy };
});

const { inferOutputFormatFromPath, loadInputImage, resolveOutputPath } = await import(
  "../file-utils.js"
);

const GEMINI = "gemini-3.1-flash-image" as const;
const OPENAI = "gpt-image-2.5-flare" as const;
/** gemini-3.1-flash-image's `maxInputImageBytes`. */
const GEMINI_LIMIT = 7 * 1024 * 1024;
const GEMINI_FORMATS = "jpeg, png, webp, gif, heic, heif";

/** Serve a canned response to the next fetch and hand back the spy. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A body that arrives in chunks, with no content-length. */
function chunkedBody(chunks: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

let tmp: string;

beforeEach(async () => {
  readFileSpy.mockClear();
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

  it.each(OUTPUT_FORMATS)("replaces a foreign extension with the %s extension", async (format) => {
    const resolved = await resolveOutputPath(path.join(tmp, "foo.txt"), format);
    expect(resolved).toBe(path.join(tmp, `foo${FILE_EXTENSIONS[format]}`));
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

  it("never overwrites an existing file: -2, then -3", async () => {
    const base = path.join(tmp, "foo.jpg");
    await fs.writeFile(base, "already here");
    expect(await resolveOutputPath(base, "jpeg")).toBe(path.join(tmp, "foo-2.jpg"));

    await fs.writeFile(path.join(tmp, "foo-2.jpg"), "also here");
    expect(await resolveOutputPath(base, "jpeg")).toBe(path.join(tmp, "foo-3.jpg"));

    // The bytes of the file that was already there are untouched.
    expect(await fs.readFile(base, "utf8")).toBe("already here");
  });

  it("continues past an existing file for every image of a num_images call", async () => {
    const base = path.join(tmp, "foo.jpg");
    await fs.writeFile(base, "already here");

    const first = await resolveOutputPath(base, "jpeg", 0);
    expect(first).toBe(path.join(tmp, "foo-2.jpg"));
    await fs.writeFile(first, "image 1");

    expect(await resolveOutputPath(base, "jpeg", 1)).toBe(path.join(tmp, "foo-3.jpg"));
  });

  it("skips a taken name in directory mode, so two images of the same millisecond cannot collide", async () => {
    // The timestamp is the filename, so freezing the clock is what makes the
    // second call ask for the name the first one took.
    vi.useFakeTimers();
    try {
      const first = await resolveOutputPath(tmp, "jpeg");
      await fs.writeFile(first, "image 1");

      const second = await resolveOutputPath(tmp, "jpeg");
      expect(path.basename(second)).toBe(
        path.basename(first).replace(/\.jpg$/, "-2.jpg")
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inferOutputFormatFromPath", () => {
  it.each([
    ["pic.jpg", "jpeg"],
    ["pic.jpeg", "jpeg"],
    ["pic.png", "png"],
    ["pic.webp", "webp"],
    ["PIC.PNG", "png"],
    ["notes.txt", undefined],
    ["images/", undefined],
  ])("reads '%s' as %s", (name, format) => {
    expect(inferOutputFormatFromPath(path.join(tmp, name))).toBe(format);
  });
});

describe("loadInputImage", () => {
  it("rejects a file whose extension names no image type, without reading it", async () => {
    // Neither path exists: a "not found" here would mean the type check ran
    // after the disk was touched.
    const named = path.join(tmp, "notes.txt");
    await expect(loadInputImage(named, GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: `Error: Cannot determine the image type of '${named}' from its extension '.txt'. Supported input formats for 'gemini-3.1-flash-image' (Nano Banana 2): ${GEMINI_FORMATS}. Rename or convert the image.`,
      })
    );

    const bare = path.join(tmp, "screenshot");
    await expect(loadInputImage(bare, GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("from its extension '(none)'"),
      })
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("rejects a type the model does not accept before reading the bytes", async () => {
    const gif = path.join(tmp, "loop.gif");
    await fs.writeFile(gif, "gif-bytes");

    await expect(loadInputImage(gif, OPENAI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: expect.stringContaining("does not accept image/gif input"),
      })
    );
    expect(readFileSpy).not.toHaveBeenCalled();

    // A Gemini model takes the same file, so the rejection was the allowlist.
    expect(await loadInputImage(gif, GEMINI)).toEqual({
      data: Buffer.from("gif-bytes").toString("base64"),
      mimeType: "image/gif",
    });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a local file over the model's limit without reading it", async () => {
    const big = path.join(tmp, "big.png");
    await fs.writeFile(big, Buffer.alloc(GEMINI_LIMIT + 1));

    await expect(loadInputImage(big, GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.IMAGE_TOO_LARGE,
        message: `Error: Image at '${big}' is 7.00MB, above the 7MB limit for 'gemini-3.1-flash-image' (Nano Banana 2). Resize it, or use an OpenAI model (50MB limit).`,
      })
    );
    expect(readFileSpy).not.toHaveBeenCalled();

    // The same file is well within an OpenAI model's 50MB limit.
    const image = await loadInputImage(big, OPENAI);
    expect(Buffer.from(image.data, "base64")).toHaveLength(GEMINI_LIMIT + 1);
  });

  it("reports a missing file as a path error once the type is known", async () => {
    await expect(loadInputImage(path.join(tmp, "missing.png"), GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: expect.stringContaining("Image file not found"),
      })
    );
  });

  it("expands a leading ~ to HOME", async () => {
    vi.stubEnv("HOME", tmp);
    await fs.writeFile(path.join(tmp, "home.png"), "home-bytes");

    expect(await loadInputImage("~/home.png", GEMINI)).toEqual({
      data: Buffer.from("home-bytes").toString("base64"),
      mimeType: "image/png",
    });
  });

  it.each(["image/jpeg; charset=utf-8", "IMAGE/JPEG"])(
    "reads a fetched content-type of '%s' as image/jpeg",
    async (header) => {
      const bytes = Buffer.from("remote-bytes");
      const fetchMock = stubFetch(
        new Response(bytes, { status: 200, headers: { "content-type": header } })
      );

      const image = await loadInputImage("https://example.com/pic.jpg", GEMINI);

      expect(image).toEqual({ data: bytes.toString("base64"), mimeType: "image/jpeg" });
      // Without a timeout a hung server would hang the tool call.
      expect(fetchMock).toHaveBeenCalledWith("https://example.com/pic.jpg", {
        signal: expect.any(AbortSignal),
      });
    }
  );

  it("rejects a fetched image whose response reports no content-type", async () => {
    stubFetch(new Response(Buffer.from("remote-bytes"), { status: 200 }));

    await expect(loadInputImage("https://example.com/pic", GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: `Error: Cannot determine the image type of 'https://example.com/pic' because the server did not report a content-type. Supported input formats for 'gemini-3.1-flash-image' (Nano Banana 2): ${GEMINI_FORMATS}. Rename or convert the image.`,
      })
    );
  });

  it("rejects an oversize content-length before reading the body", async () => {
    // Reading this body fails with its own error, so seeing IMAGE_TOO_LARGE is
    // the proof that nothing read it.
    const poisoned = new ReadableStream({
      start(controller) {
        controller.error(new Error("the body must not be read"));
      },
    });
    stubFetch(
      new Response(poisoned, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(GEMINI_LIMIT + 1),
        },
      })
    );

    await expect(loadInputImage("https://example.com/big.png", GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.IMAGE_TOO_LARGE,
        message: expect.stringContaining("above the 7MB limit for 'gemini-3.1-flash-image'"),
      })
    );
  });

  it("stops a body that passes the limit even when nothing declared its size", async () => {
    const megabyte = Buffer.alloc(1024 * 1024);
    stubFetch(
      new Response(chunkedBody(Array.from({ length: 8 }, () => megabyte)), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );

    await expect(loadInputImage("https://example.com/lying.png", GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.IMAGE_TOO_LARGE,
        message: expect.stringContaining("above the 7MB limit"),
      })
    );
  });

  it("returns a chunked body that stays within the limit", async () => {
    const chunks = [Buffer.from("first-"), Buffer.from("second")];
    stubFetch(
      new Response(chunkedBody(chunks), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );

    const image = await loadInputImage("https://example.com/ok.png", GEMINI);

    expect(Buffer.from(image.data, "base64").toString()).toBe("first-second");
  });

  it("reports a non-OK HTTP response as INVALID_IMAGE_PATH with the status code", async () => {
    stubFetch(new Response("nope", { status: 404 }));

    await expect(loadInputImage("https://example.com/missing.png", GEMINI)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_IMAGE_PATH,
        message: expect.stringContaining("status 404"),
      })
    );
  });

  it("does not treat non-http schemes as URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadInputImage("file:///etc/hosts", GEMINI)).rejects.toThrowError(
      expect.objectContaining({ type: ErrorType.INVALID_IMAGE_PATH })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
