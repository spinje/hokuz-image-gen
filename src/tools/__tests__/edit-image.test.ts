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
    // resolution, temperature and quality have no schema default here: each
    // reaches the service only when the caller asked for it.
    const config = editMock.mock.calls[0][2];
    expect(config).toEqual({
      model: DEFAULTS.model,
      aspectRatio: undefined,
      resolution: undefined,
      temperature: undefined,
      outputFormat: DEFAULTS.outputFormat,
      quality: undefined,
      transparentBackground: undefined,
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

  it("rejects more input images than the model accepts before reading any of them", async () => {
    // Within the schema bound (16) but over the Gemini limit; the paths do not
    // exist, so a "not found" here would mean a file was read first.
    const missing = Array.from({ length: 15 }, (_, i) => path.join(tmp, `missing-${i}.png`));

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: missing,
      output_path: tmp,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error: Model 'gemini-3.1-flash-image' (Nano Banana 2) accepts at most 14 input images; 15 were given. Remove images, or use an OpenAI model (up to 16)."
    );
    expect(editMock).not.toHaveBeenCalled();
  });

  it("applies the selected model's own byte limit to an input image", async () => {
    // 7 MB + 1 byte: over the Gemini limit, far inside the OpenAI one. This is
    // the only test that observes maxInputImageBytes reaching the loader.
    const big = path.join(tmp, "big.png");
    await fs.writeFile(big, Buffer.alloc(7 * 1024 * 1024 + 1));

    const rejected = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [big],
      output_path: tmp,
    });

    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toBe(
      `Error: Image at '${big}' is 7.00MB, above the 7MB limit for 'gemini-3.1-flash-image' (Nano Banana 2). Resize it, or use an OpenAI model (50MB limit).`
    );
    expect(editMock).not.toHaveBeenCalled();

    const accepted = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [big],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
    });

    expect(accepted.isError).toBeFalsy();
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an input type the model does not accept before any API call", async () => {
    const gif = path.join(tmp, "loop.gif");
    await fs.writeFile(gif, "gif-image");

    const rejected = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [gif],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
    });

    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toBe(
      `Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not accept image/gif input ('${gif}'). Supported input formats: jpeg, png, webp. Convert the image, or use a Gemini model.`
    );
    expect(editMock).not.toHaveBeenCalled();

    // The same model takes the PNG next to it.
    const accepted = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [first],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
    });
    expect(accepted.isError).toBeFalsy();
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  it("takes the output format from the output_path's extension, which then faces validation", async () => {
    // The generate tool proves the precedence; this guards edit's own copy of
    // the line, which nothing else here would notice going missing.
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [first],
      output_path: path.join(tmp, "out.png"),
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/does not support output_format 'png'/);
    expect(editMock).not.toHaveBeenCalled();
  });

  it("rejects an explicit resolution on an OpenAI model with the default 'auto' ratio", async () => {
    // With a schema default on resolution the handler could not tell this from
    // "the caller said nothing", and the 2K would be silently ignored.
    const result = await harness.callTool(TOOL, {
      prompt: "p",
      image_paths: [first],
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      resolution: "2K",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) cannot apply resolution '2K' when aspect_ratio is 'auto' because the provider chooses the output size. Set an aspect_ratio to control the size, or omit resolution."
    );
    expect(editMock).not.toHaveBeenCalled();
  });
});
