import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DEFAULTS } from "../../constants.js";
import { ErrorType, McpError } from "../../types.js";

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/index.js")>();
  return { ...actual, generateImage: generateMock };
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-gen-"));
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe(TOOL, () => {
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
    });

    const saved = path.join(tmp, "lake.jpg");
    expect(await fs.readFile(saved)).toEqual(Buffer.from("fake-jpeg-bytes"));
    expect(result.structuredContent).toEqual({
      success: true,
      images: [{ path: saved, format: "jpeg" }],
      description: "a lake",
    });
    expect(firstText(result)).toContain("Successfully generated 1 image(s)");
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

  it("makes one request per requested image and suffixes the filenames", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: path.join(tmp, "v.jpg"),
      num_images: 3,
    });

    expect(generateMock).toHaveBeenCalledTimes(3);
    const paths = (result.structuredContent as { images: Array<{ path: string }> }).images.map(
      (i) => i.path
    );
    expect(paths).toEqual([
      path.join(tmp, "v.jpg"),
      path.join(tmp, "v-2.jpg"),
      path.join(tmp, "v-3.jpg"),
    ]);
    for (const p of paths) await fs.access(p);
  });

  it("saves only the requested count when a single response carries extra images", async () => {
    generateMock.mockResolvedValue({
      images: [
        { data: IMG, mimeType: "image/jpeg" },
        { data: Buffer.from("second").toString("base64"), mimeType: "image/jpeg" },
      ],
    });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: path.join(tmp, "one.jpg"),
    });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(1);
    expect(await fs.readdir(tmp)).toEqual(["one.jpg"]);
  });

  it("keeps what it has and warns when a later request fails", async () => {
    generateMock
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new McpError(ErrorType.API_RATE_LIMIT, "Error: Rate limit exceeded."));

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      num_images: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({ success: true });
    expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      warning:
        "Requested 3 image(s) but only 1 were produced. The failed request reported: Error: Rate limit exceeded.",
    });
    expect(firstText(result)).toContain(
      "Warning: Requested 3 image(s) but only 1 were produced. The failed request reported: Error: Rate limit exceeded."
    );
  });

  it("surfaces the error when the first request fails", async () => {
    generateMock.mockRejectedValue(
      new McpError(ErrorType.CONTENT_BLOCKED, "Error: Content was blocked by safety filters.")
    );

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("blocked by safety filters");
    expect(result.structuredContent).toEqual({
      success: false,
      images: [],
      error: "Error: Content was blocked by safety filters.",
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

  it("passes a PNG transparent request through and saves the file with that extension", async () => {
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
    // The output path's extension follows the format, not what the caller typed.
    expect(result.structuredContent).toMatchObject({
      images: [{ path: path.join(tmp, "sticker.png"), format: "png" }],
    });
    expect(await fs.readdir(tmp)).toEqual(["sticker.png"]);
  });

  it("rejects png on a Gemini model before calling the provider", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      output_format: "png",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error: Model 'gemini-3.1-flash-image' (Nano Banana 2) does not support output_format 'png'. Supported: jpeg. Gemini models produce jpeg only; use gpt-image-2.5-flare or gpt-image-2.5-sunburst for png/webp."
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("reports the provider's pixel size and sums usage across the num_images loop", async () => {
    generateMock.mockResolvedValue({
      images: [{ data: IMG, mimeType: "image/jpeg", width: 1360, height: 768 }],
      usage: { inputTokens: 15, outputTokens: 229, estimatedCostUsd: 0.007 },
    });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      aspect_ratio: "16:9",
      num_images: 2,
    });

    expect(result.structuredContent).toMatchObject({
      usage: { input_tokens: 30, output_tokens: 458, estimated_cost_usd: 0.014 },
    });
    const images = (result.structuredContent as {
      images: Array<{ width?: number; height?: number }>;
    }).images;
    expect(images.map((i) => [i.width, i.height])).toEqual([
      [1360, 768],
      [1360, 768],
    ]);
    expect(firstText(result)).toContain("(1360x768)");
    expect(firstText(result)).toContain(
      "Usage: 30 input + 458 output tokens, estimated cost $0.0140"
    );
  });

  it("says how many requests the usage totals cover when it is not all of them", async () => {
    generateMock
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: { inputTokens: 15, outputTokens: 229, estimatedCostUsd: 0.007 },
      })
      .mockResolvedValueOnce(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      num_images: 2,
    });

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(firstText(result)).toContain(
      "Usage (reported for 1 of 2 requests): 15 input + 229 output tokens, estimated cost $0.0070"
    );
  });

  it("omits usage and dimensions for a provider that reports neither", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    // toEqual treats an undefined-valued key as absent, which is what a JSON
    // transport delivers; the point is that neither field carries a value.
    expect(result.structuredContent).toEqual({
      success: true,
      images: [{ path: expect.any(String), format: "jpeg" }],
    });
    expect(firstText(result)).not.toContain("Usage:");
    expect(firstText(result)).toContain("Successfully generated 1 image(s)");
  });
});
