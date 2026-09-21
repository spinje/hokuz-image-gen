import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FILE_EXTENSIONS, OUTPUT_FORMATS } from "../../constants.js";
import { ErrorType } from "../../types.js";

// The loader must reject a file on its metadata alone; `open` staying
// uncalled is how the tests below observe that.
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));

// Transport policy has its own DNS/socket/redirect seam tests. These tests
// exercise MIME/size/body handling with canned Responses, never live fetches.
vi.mock("../remote-image.js", () => ({ fetchRemoteImage: (url: string, init: RequestInit) => fetch(url, init) }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  openSpy.mockImplementation(actual.open);
  return { ...actual, open: openSpy };
});

const { inferOutputFormatFromPath, loadInputImage, saveBase64Image } = await import(
  "../file-utils.js"
);

// Naming cases also exercise the real exclusive write with a tiny byte fixture.
const save = (output: string, format: typeof OUTPUT_FORMATS[number], index = 0) =>
  saveBase64Image(Buffer.from("image bytes").toString("base64"), output, format, index);

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
  openSpy.mockClear();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

const TIMESTAMPED = /^image-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}\.jpg$/;

describe("saveBase64Image naming", () => {
  it("claims distinct filenames for concurrent writers without replacing existing bytes", async () => {
    const requested = path.join(tmp, "race.png");
    await fs.writeFile(requested, "irreplaceable original");
    const a = Buffer.from("first paid image"); const b = Buffer.from("second paid image");
    const saved = await Promise.all([a, b].map(bytes => saveBase64Image(bytes.toString("base64"), requested, "png")));
    expect(new Set(saved).size).toBe(2);
    expect(saved.sort()).toEqual([path.join(tmp, "race-2.png"), path.join(tmp, "race-3.png")]);
    expect(await fs.readFile(requested, "utf8")).toBe("irreplaceable original");
    const contents = await Promise.all(saved.map(name => fs.readFile(name, "utf8")));
    expect(contents.sort()).toEqual([a.toString(), b.toString()].sort());
  });

  it("bounds name collisions and does not retry unrelated write failures", async () => {
    const write = vi.spyOn(fs, "writeFile").mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    await expect(save(path.join(tmp, "full.jpg"), "jpeg", 2)).rejects.toMatchObject({ type: ErrorType.FILE_WRITE_ERROR, message: expect.stringContaining("10000 attempts") });
    expect(write).toHaveBeenCalledTimes(10_000);
    write.mockClear().mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(save(path.join(tmp, "denied.jpg"), "jpeg")).rejects.toMatchObject({ type: ErrorType.FILE_WRITE_ERROR, message: expect.stringContaining("Could not write") });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("treats an existing directory as a directory and generates a timestamped name", async () => {
    const resolved = await save(tmp, "jpeg");
    expect(path.dirname(resolved)).toBe(tmp);
    expect(path.basename(resolved)).toMatch(TIMESTAMPED);
  });

  it("treats a trailing separator as a directory even when it does not exist yet", async () => {
    const dir = path.join(tmp, "new-dir");
    const resolved = await save(`${dir}/`, "jpeg");
    expect(path.dirname(resolved)).toBe(dir);
    expect(path.basename(resolved)).toMatch(TIMESTAMPED);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it.each(OUTPUT_FORMATS)("replaces a foreign extension with the %s extension", async (format) => {
    const resolved = await save(path.join(tmp, "foo.txt"), format);
    expect(resolved).toBe(path.join(tmp, `foo${FILE_EXTENSIONS[format]}`));
  });

  it("appends the extension when the file path has none", async () => {
    const resolved = await save(path.join(tmp, "foo"), "jpeg");
    expect(resolved).toBe(path.join(tmp, "foo.jpg"));
  });

  it("creates a missing parent directory in file mode", async () => {
    const resolved = await save(path.join(tmp, "a", "b", "foo.jpg"), "jpeg");
    expect(resolved).toBe(path.join(tmp, "a", "b", "foo.jpg"));
    expect((await fs.stat(path.join(tmp, "a", "b"))).isDirectory()).toBe(true);
  });

  it("suffixes -2, -3 from the second image onward in file mode", async () => {
    const base = path.join(tmp, "foo.jpg");
    expect(await save(base, "jpeg", 0)).toBe(path.join(tmp, "foo.jpg"));
    expect(await save(base, "jpeg", 1)).toBe(path.join(tmp, "foo-2.jpg"));
    expect(await save(base, "jpeg", 2)).toBe(path.join(tmp, "foo-3.jpg"));
  });

  it("suffixes the index in directory mode too, so same-millisecond images cannot collide", async () => {
    // num_images > 1 into a directory resolves each path within the same
    // millisecond in practice; the index suffix is the only thing keeping
    // them distinct.
    const first = path.basename(await save(tmp, "jpeg", 0));
    const second = path.basename(await save(tmp, "jpeg", 1));
    expect(first).toMatch(TIMESTAMPED);
    expect(second).toMatch(/^image-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-2\.jpg$/);
  });

  it("expands a leading ~ to HOME", async () => {
    vi.stubEnv("HOME", tmp);
    const resolved = await save("~/pics/foo.jpg", "jpeg");
    expect(resolved).toBe(path.join(tmp, "pics", "foo.jpg"));
  });

  it("never overwrites an existing file: -2, then -3", async () => {
    const base = path.join(tmp, "foo.jpg");
    await fs.writeFile(base, "already here");
    expect(await save(base, "jpeg")).toBe(path.join(tmp, "foo-2.jpg"));

    await fs.writeFile(path.join(tmp, "foo-2.jpg"), "also here");
    expect(await save(base, "jpeg")).toBe(path.join(tmp, "foo-3.jpg"));

    // The bytes of the file that was already there are untouched.
    expect(await fs.readFile(base, "utf8")).toBe("already here");
  });

  it("continues past an existing file for every image of a num_images call", async () => {
    const base = path.join(tmp, "foo.jpg");
    await fs.writeFile(base, "already here");

    const first = await save(base, "jpeg", 0);
    expect(first).toBe(path.join(tmp, "foo-2.jpg"));
    await fs.writeFile(first, "image 1");

    expect(await save(base, "jpeg", 1)).toBe(path.join(tmp, "foo-3.jpg"));
  });

  it("skips a taken name in directory mode, so two images of the same millisecond cannot collide", async () => {
    // The timestamp is the filename, so freezing the clock is what makes the
    // second call ask for the name the first one took.
    vi.useFakeTimers();
    try {
      const first = await save(tmp, "jpeg");
      await fs.writeFile(first, "image 1");

      const second = await save(tmp, "jpeg");
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
  it("rejects metadata above the remaining budget before opening the local file", async () => {
    const source = path.join(tmp, "budget.png"); await fs.writeFile(source, "12345");
    await expect(loadInputImage(source, OPENAI, undefined, 4)).rejects.toMatchObject({ type: ErrorType.IMAGE_TOO_LARGE });
    expect(openSpy).not.toHaveBeenCalled();
    expect(await loadInputImage(source, OPENAI, undefined, 5)).toMatchObject({ data: Buffer.from("12345").toString("base64") });
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds actual local bytes when the file grows after both size checks", async () => {
    const source = path.join(tmp, "growing.png"); await fs.writeFile(source, "123");
    const actualOpen = openSpy.getMockImplementation()!;
    let closed = false;
    openSpy.mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const stat = handle.stat.bind(handle); const close = handle.close.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const result = await stat(); await fs.appendFile(source, "45"); return result;
      });
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
      return handle;
    });
    await expect(loadInputImage(source, OPENAI, undefined, 4)).rejects.toMatchObject({ type: ErrorType.IMAGE_TOO_LARGE });
    expect(closed).toBe(true);
    expect(await fs.readFile(source, "utf8")).toBe("12345");
  });

  it("enforces the remaining budget while streaming a URL and cancels rejected bodies", async () => {
    const cancelled = vi.fn();
    stubFetch(new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("123")); controller.enqueue(Buffer.from("45")); controller.enqueue(Buffer.from("6")); controller.close(); },
      cancel: cancelled,
    }), { headers: { "content-type": "image/png" } }));
    await expect(loadInputImage("https://example.com/budget.png", OPENAI, undefined, 4)).rejects.toMatchObject({ type: ErrorType.IMAGE_TOO_LARGE });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("observes cancellation after opening a file before reading its bytes", async () => {
    const source = path.join(tmp, "cancelled.png"); await fs.writeFile(source, "123");
    const controller = new AbortController(); const actualOpen = openSpy.getMockImplementation()!;
    let readCalls = () => -1;
    openSpy.mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args); const stat = handle.stat.bind(handle);
      const read = vi.spyOn(handle, "read"); readCalls = () => read.mock.calls.length;
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => { const result = await stat(); controller.abort(); return result; });
      return handle;
    });
    await expect(loadInputImage(source, OPENAI, controller.signal)).rejects.toMatchObject({ type: ErrorType.REQUEST_CANCELLED });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(readCalls()).toBe(0);
  });
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
    expect(openSpy).not.toHaveBeenCalled();
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
    expect(openSpy).not.toHaveBeenCalled();

    // A Gemini model takes the same file, so the rejection was the allowlist.
    expect(await loadInputImage(gif, GEMINI)).toEqual({
      data: Buffer.from("gif-bytes").toString("base64"),
      mimeType: "image/gif",
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
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
    expect(openSpy).not.toHaveBeenCalled();

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

  it("separates a transient fetch failure from a URL that is simply wrong", async () => {
    // INVALID_IMAGE_PATH otherwise means "fix the arguments", so a timeout or a
    // failing host would tell the caller to rewrite a URL that is already right.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" })));
    await expect(loadInputImage("https://example.com/pic.jpg", GEMINI)).rejects.toMatchObject({
      type: ErrorType.INVALID_IMAGE_PATH,
      retryable: true,
    });

    stubFetch(new Response(null, { status: 503 }));
    await expect(loadInputImage("https://example.com/pic.jpg", GEMINI)).rejects.toMatchObject({
      retryable: true,
    });

    // A 404 from the host is the URL being wrong, and repeating it cannot help.
    stubFetch(new Response(null, { status: 404 }));
    await expect(loadInputImage("https://example.com/pic.jpg", GEMINI)).rejects.toMatchObject({
      retryable: false,
    });
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
