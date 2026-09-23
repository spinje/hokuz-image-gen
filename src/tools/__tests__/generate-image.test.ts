import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DEFAULTS } from "../../constants.js";

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/index.js")>();
  return { ...actual, requireProviderKey: vi.fn(), generateImage: generateMock };
});

const { connectTestClient, firstText } = await import("../../__tests__/harness.js");

const TOOL = "hokuz_generate_image";
const IMG = Buffer.from("fake-jpeg-bytes").toString("base64");
const okResponse = (description?: string) => ({
  images: [{ data: IMG, mimeType: "image/jpeg" }],
  description,
});

let tmp: string;
let harness: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  generateMock.mockReset();
  vi.stubEnv("HOKUZ_OUTPUT_ROOT", undefined);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-gen-"));
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe(TOOL, () => {
  it.each(["child.jpg", "missing/child.jpg", ""])("rejects a file used as an output directory before generation (%s)", async (suffix) => {
    const parent = path.join(tmp, "notes.txt");
    await fs.writeFile(parent, "keep this");
    generateMock.mockResolvedValue(okResponse());
    const outputPath = `${parent}/${suffix}`;

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: outputPath });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "failed",
      images: [],
      issue: {
        code: "FILE_WRITE_ERROR",
        message: expect.stringContaining("Could not resolve an output directory"),
        next_step: expect.stringContaining("accessible directories"),
      },
    });
    expect(firstText(result)).toContain("Generation did not start.");
    expect(generateMock).not.toHaveBeenCalled();
    expect(await fs.readFile(parent, "utf8")).toBe("keep this");
  });

  it("applies defaults when optional params are omitted and writes the file", async () => {
    generateMock.mockResolvedValue(okResponse("a lake"));

    const result = await harness.callTool(TOOL, {
      prompt: "a lake",
      output_path: path.join(tmp, "lake.jpg"),
    });

    expect(result.isError).toBeFalsy();
    expect(generateMock).toHaveBeenCalledTimes(1);
    // temperature and quality have no schema default: the provider that owns
    // the option applies its own, so the config carries neither.
    expect(generateMock).toHaveBeenCalledWith("a lake", {
      model: DEFAULTS.model,
      aspectRatio: DEFAULTS.aspectRatio,
      resolution: DEFAULTS.resolution,
      temperature: undefined,
      outputFormat: DEFAULTS.outputFormat,
      quality: undefined,
      transparentBackground: undefined,
    }, expect.any(AbortSignal));

    const saved = path.join(tmp, "lake.jpg");
    expect(await fs.readFile(saved)).toEqual(Buffer.from("fake-jpeg-bytes"));
    expect(result.structuredContent).toEqual({
      status: "complete",
      images: [{ path: saved, format: "jpeg" }],
      description: "a lake",
    });
    expect(firstText(result)).toContain("complete: 1 of 1 requested image(s) saved.");
  });

  it("forwards explicit params to the service", async () => {
    generateMock.mockResolvedValue(okResponse());

    await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gemini-3-pro-image",
      aspect_ratio: "21:9",
      resolution: "4K",
      temperature: 0.2,
    });

    expect(generateMock.mock.calls[0][1]).toMatchObject({
      model: "gemini-3-pro-image",
      aspectRatio: "21:9",
      resolution: "4K",
      temperature: 0.2,
    });
  });

  it("rejects an unsupported model/resolution combination before calling the service", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gemini-3.1-flash-lite-image",
      resolution: "2K",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/does not support resolution '2K'/);
    // A pre-flight rejection is an argument problem, not an API failure.
    expect((result.structuredContent?.issue as { code: string })?.code).toBe("INVALID_MODEL_OPTION");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range and unknown arguments at the schema boundary", async () => {
    // The SDK reports input-schema failures as an isError result, not a thrown error.
    const tooMany = await harness.callTool(TOOL, { prompt: "p", output_path: tmp, num_images: 5 });
    expect(tooMany.isError).toBe(true);
    expect(firstText(tooMany)).toMatch(/Invalid arguments.*num_images/s);

    const unknown = await harness.callTool(TOOL, { prompt: "p", output_path: tmp, bogus: true });
    expect(unknown.isError).toBe(true);
    expect(firstText(unknown)).toMatch(/Invalid arguments/);

    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes a provider-specific option through untouched, defaulting neither", async () => {
    generateMock.mockResolvedValue(okResponse());

    await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      quality: "high",
    });

    expect(generateMock.mock.calls[0][1]).toEqual({
      model: "gpt-image-2.5-flare",
      aspectRatio: DEFAULTS.aspectRatio,
      resolution: DEFAULTS.resolution,
      outputFormat: DEFAULTS.outputFormat,
      quality: "high",
      temperature: undefined,
    });
  });

  it("lets an explicit output_format win over the output_path's extension", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "a sticker",
      output_path: path.join(tmp, "sticker.jpg"),
      model: "gpt-image-2.5-flare",
      output_format: "png",
      transparent_background: true,
    });

    expect(result.isError).toBeFalsy();
    expect(generateMock.mock.calls[0][1]).toMatchObject({
      outputFormat: "png",
      transparentBackground: true,
    });
    // The saved extension follows the format, not the '.jpg' the caller typed.
    expect(result.structuredContent).toMatchObject({
      images: [{ path: path.join(tmp, "sticker.png"), format: "png" }],
    });
    expect(await fs.readdir(tmp)).toEqual(["sticker.png"]);
  });

  it("takes the output format from the output_path's extension when none is given", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "a sticker",
      output_path: path.join(tmp, "logo.png"),
      model: "gpt-image-2.5-flare",
      transparent_background: true,
    });

    expect(result.isError).toBeFalsy();
    expect(generateMock.mock.calls[0][1]).toMatchObject({ outputFormat: "png" });
    expect(result.structuredContent).toMatchObject({
      images: [{ path: path.join(tmp, "logo.png"), format: "png" }],
    });
    expect(await fs.readdir(tmp)).toEqual(["logo.png"]);
  });

  it("rejects a .png output_path on a Gemini model instead of saving a JPEG", async () => {
    // The inferred format goes through the same validation as an explicit one,
    // which is the whole point of inferring it.
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: path.join(tmp, "x.png"),
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/does not support output_format 'png'/);
    expect(generateMock).not.toHaveBeenCalled();
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("rejects png on a Gemini model before calling the provider", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      output_format: "png",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Model 'gemini-3.1-flash-image' (Nano Banana 2) does not support output_format 'png'."
    );
    expect(generateMock).not.toHaveBeenCalled();
  });
});
