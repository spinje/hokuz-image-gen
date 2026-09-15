import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DEFAULTS } from "../../constants.js";

const { editMock } = vi.hoisted(() => ({ editMock: vi.fn() }));

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/index.js")>();
  return { ...actual, editImage: editMock };
});

const { connectTestClient, firstText } = await import("../../__tests__/harness.js");

const TOOL = "hokuz_edit_image";
const OUT = Buffer.from("edited-bytes").toString("base64");

let tmp: string;
let harness: Awaited<ReturnType<typeof connectTestClient>>;
let first: string;
let second: string;

beforeEach(async () => {
  editMock.mockReset();
  editMock.mockResolvedValue({ images: [{ data: OUT, mimeType: "image/jpeg" }] });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-edit-"));
  first = path.join(tmp, "first.png");
  second = path.join(tmp, "second.webp");
  await fs.writeFile(first, "first-image");
  await fs.writeFile(second, "second-image");
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe(TOOL, () => {
  it("defaults aspect_ratio to 'auto', which reaches the service as undefined", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "make it blue",
      image_paths: [first],
      output_path: path.join(tmp, "out.jpg"),
    });

    expect(result.isError).toBeFalsy();
    const config = editMock.mock.calls[0][2];
    expect(config).toEqual({
      model: DEFAULTS.model,
      aspectRatio: undefined,
      resolution: DEFAULTS.resolution,
      temperature: DEFAULTS.temperature,
      outputFormat: DEFAULTS.outputFormat,
      quality: undefined,
    });
    expect(await fs.readFile(path.join(tmp, "out.jpg"))).toEqual(Buffer.from("edited-bytes"));
  });

  it("passes an explicit aspect ratio through unchanged", async () => {
    await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [first],
      output_path: tmp,
      aspect_ratio: "9:16",
    });
    expect(editMock.mock.calls[0][2]).toMatchObject({ aspectRatio: "9:16" });
  });

  it("loads input images in the given order with MIME types from their extensions", async () => {
    await harness.callTool(TOOL, {
      prompt: "compose",
      image_paths: [second, first],
      output_path: tmp,
    });

    const [prompt, images] = editMock.mock.calls[0];
    expect(prompt).toBe("compose");
    expect(images).toEqual([
      { data: Buffer.from("second-image").toString("base64"), mimeType: "image/webp" },
      { data: Buffer.from("first-image").toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("validates model options before loading any image", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [path.join(tmp, "does-not-exist.png")],
      output_path: tmp,
      model: "gemini-3-pro-image",
      aspect_ratio: "1:8",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/does not support aspect ratio '1:8'/);
    expect(firstText(result)).not.toMatch(/not found/);
    expect(editMock).not.toHaveBeenCalled();
  });

  it("reports a missing input image as INVALID_IMAGE_PATH without calling the service", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [path.join(tmp, "missing.png")],
      output_path: tmp,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/Image file not found/);
    expect(editMock).not.toHaveBeenCalled();
  });

  it("rejects more than the maximum number of input images at the schema boundary", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: Array.from({ length: 15 }, () => first),
      output_path: tmp,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/Invalid arguments.*image_paths/s);
    expect(editMock).not.toHaveBeenCalled();
  });

  it("applies each provider's own optional defaults and omits the other's", async () => {
    await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [first],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
    });

    expect(editMock.mock.calls[0][2]).toEqual({
      model: "gpt-image-2.5-flare",
      aspectRatio: undefined,
      resolution: DEFAULTS.resolution,
      outputFormat: DEFAULTS.outputFormat,
      quality: DEFAULTS.quality,
      temperature: undefined,
    });
  });

  it("rejects an explicit temperature on an OpenAI model before loading any image", async () => {
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [path.join(tmp, "does-not-exist.png")],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      temperature: 0.2,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not accept 'temperature'; it is a Gemini-only option. Omit it, or use a gemini-* model."
    );
    expect(editMock).not.toHaveBeenCalled();
  });
});
