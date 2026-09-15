import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DEFAULTS } from "../../constants.js";
import { ErrorType, McpError } from "../../types.js";

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock("../../services/gemini-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gemini-client.js")>();
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
    expect(generateMock).toHaveBeenCalledWith("a lake", {
      model: DEFAULTS.model,
      aspectRatio: DEFAULTS.aspectRatio,
      resolution: DEFAULTS.resolution,
      temperature: DEFAULTS.temperature,
      outputFormat: DEFAULTS.outputFormat,
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
    expect(firstText(result)).toContain("Warning: requested 3 image(s) but only 1 were produced");
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
});
