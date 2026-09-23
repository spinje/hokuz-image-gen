/**
 * The pipeline in `tools/image-tool.ts` — the num_images loop, saving, usage,
 * the issue and the failure result — is shared by both tools, so it is
 * tested once, through hokuz_generate_image (the tool with the simpler
 * mapping). `generate-image.test.ts` and `edit-image.test.ts` then cover only
 * what is their own: the param -> GenerationConfig mapping, image loading, and
 * validation order.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import * as previews from "../../services/image-preview.js";
import type { ImageToolOutput } from "../../schemas/output.js";
import { ErrorType, ToolError } from "../../types.js";

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
  vi.restoreAllMocks();
  generateMock.mockReset();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-pipeline-"));
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("image tool pipeline", () => {
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

  it("preserves the provider's recovery advice alongside partial results", async () => {
    generateMock.mockResolvedValueOnce(okResponse()).mockRejectedValueOnce(
      new ToolError(ErrorType.API_RATE_LIMIT, "Account limit reached.", "Wait until capacity is available.")
    );
    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp, num_images: 3 });
    const output = result.structuredContent as ImageToolOutput;
    expect(result.isError).toBeFalsy();
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(output).toMatchObject({ status: "partial", issue: {
      code: "API_RATE_LIMIT", message: "Account limit reached.",
      next_step: "Wait until capacity is available. Keep the 1 saved image(s). If making another request, set num_images to 2 for only the missing images.",
    } });
    expect(output.images).toHaveLength(1);
    expect(firstText(result)).toContain(output.images[0].path);
    expect(firstText(result)).toContain(output.issue!.next_step);
    expect(firstText(result)).toContain("1 of 3 requested image(s) saved");
  });

  it("preserves a first-request error without claiming generation never started", async () => {
    generateMock.mockRejectedValue(new ToolError(ErrorType.CONTENT_BLOCKED,
      "The provider reported a moderation block.", "Revise the prompt."));
    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "failed", images: [], issue: {
      code: "CONTENT_BLOCKED", message: "The provider reported a moderation block.", next_step: "Revise the prompt.",
    } });
    expect(firstText(result)).toContain("Revise the prompt.");
    expect(firstText(result)).not.toContain("Generation did not start");
  });

  it("keeps raw unexpected exceptions out of the agent-facing response", async () => {
    generateMock.mockRejectedValue(new Error("internal details boom"));
    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "failed", images: [], issue: {
      code: "UNKNOWN_ERROR", message: expect.stringContaining("could not be confirmed"),
      next_step: expect.stringContaining("Do not automatically repeat"),
    } });
    expect(JSON.stringify(result)).not.toContain("internal details boom");
  });

  it("reports the provider's pixel size and sums usage across the num_images loop", async () => {
    generateMock.mockResolvedValue({
      images: [{ data: IMG, mimeType: "image/jpeg", width: 1360, height: 768 }],
      usage: {
        inputTokens: 15,
        outputTokens: 229,
        estimatedCostUsd: 0.007,
        costBasis: "tokens",
      },
    });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      aspect_ratio: "16:9",
      num_images: 2,
    });

    expect(result.structuredContent).toMatchObject({
      usage: {
        input_tokens: 30,
        output_tokens: 458,
        estimated_cost_usd: 0.014,
        cost_basis: "tokens",
        requests_succeeded: 2,
        requests_reported: 2,
      },
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
      "Usage (reported for 2 of 2 requests that returned images): 30 input + 458 output tokens, estimated cost $0.0140 (from those token counts)"
    );
  });

  it("says how many requests the usage totals cover when it is not all of them", async () => {
    generateMock
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: {
          inputTokens: 15,
          outputTokens: 229,
          estimatedCostUsd: 0.007,
          costBasis: "tokens",
        },
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
      "Usage (reported for 1 of 2 requests that returned images): 15 input + 229 output tokens, estimated cost $0.0070 (from those token counts)"
    );
    // The same scope in the structured channel: a caller reading only that one
    // must not take the totals for the whole call's cost.
    expect(result.structuredContent).toMatchObject({
      usage: { requests_succeeded: 2, requests_reported: 1 },
    });
  });

  it("sums the counts of the requests that reported them, ignoring those that did not", async () => {
    // Gemini prices per image, so a request can carry a cost with no counts.
    generateMock
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: {
          inputTokens: 9,
          outputTokens: 1481,
          estimatedCostUsd: 0.0625,
          costBasis: "per_image",
        },
      })
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: { estimatedCostUsd: 0.0625, costBasis: "per_image" },
      });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      num_images: 2,
    });

    expect(result.structuredContent).toMatchObject({
      usage: {
        input_tokens: 9,
        output_tokens: 1481,
        estimated_cost_usd: 0.125,
        cost_basis: "per_image",
        // Both requests priced their image, so the totals cover the whole call.
        requests_succeeded: 2,
        requests_reported: 2,
      },
    });
    expect(firstText(result)).toContain(
      "Usage (reported for 2 of 2 requests that returned images): 9 input + 1481 output tokens, estimated cost $0.1250 (the provider's per-image price, not derived from those tokens)"
    );
  });

  it("omits a token count entirely rather than reporting 0 when no request gave one", async () => {
    // A 0 would assert the provider charged nothing for input, which is a
    // different claim from "the provider did not say". Both channels stay quiet.
    generateMock.mockResolvedValue({
      images: [{ data: IMG, mimeType: "image/jpeg" }],
      usage: { estimatedCostUsd: 0.067, costBasis: "per_image" },
    });

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    const usage = (result.structuredContent as { usage: Record<string, unknown> }).usage;
    expect(usage).toEqual({
      estimated_cost_usd: 0.067,
      cost_basis: "per_image",
      requests_succeeded: 1,
      requests_reported: 1,
    });
    expect(firstText(result)).toContain(
      "Usage (reported for 1 of 1 requests that returned images): estimated cost $0.0670 (the provider's per-image price, not derived from those tokens)"
    );
    // No count is named. The basis clause still says "tokens" to deny them, so
    // match the shape a count would take rather than the bare word.
    expect(firstText(result)).not.toMatch(/\d+ input/);
    expect(firstText(result)).not.toMatch(/\d+ output/);
  });

  it("omits usage and dimensions for a provider that reports neither", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    // toEqual treats an undefined-valued key as absent, which is what a JSON
    // transport delivers; the point is that neither field carries a value.
    expect(result.structuredContent).toEqual({
      status: "complete",
      images: [{ path: expect.any(String), format: "jpeg" }],
    });
    expect(firstText(result)).not.toContain("Usage (");
    expect(firstText(result)).toContain("Successfully generated 1 image(s)");
  });
});


describe("inline previews through MCP", () => {
  it("keeps default and false calls original-only, and bounds an enabled JPEG without changing provider config", async () => {
    const bytes = await sharp({ create: { width: 1024, height: 256, channels: 3, background: "blue" } }).jpeg().toBuffer();
    generateMock.mockResolvedValue({ images: [{ data: bytes.toString("base64"), mimeType: "image/jpeg", width: 1024, height: 256 }], usage: { estimatedCostUsd: 0.067, costBasis: "per_image" } });
    const decoder = vi.spyOn(previews, "createImagePreview");
    for (const option of [{}, { include_preview: false }]) {
      const result = await harness.callTool(TOOL, { prompt: "p", output_path: path.join(tmp, "out.jpg"), ...option });
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const output = result.structuredContent as ImageToolOutput;
      expect(output.images[0]).toEqual({ path: path.join(tmp, option.include_preview === false ? "out-2.jpg" : "out.jpg"), format: "jpeg", width: 1024, height: 256 });
      expect(await fs.readFile(output.images[0].path)).toEqual(bytes);
    }
    expect(decoder).not.toHaveBeenCalled();
    const result = await harness.callTool(TOOL, { prompt: "p", output_path: path.join(tmp, "out.jpg"), include_preview: true });
    expect(decoder).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(3);
    expect(generateMock.mock.calls[2][1]).toEqual({ model: "gemini-3.1-flash-image", aspectRatio: "1:1", resolution: "1K", outputFormat: "jpeg", temperature: undefined, quality: undefined, transparentBackground: undefined });
    const output = result.structuredContent as ImageToolOutput;
    expect(output).toMatchObject({ status: "complete", images: [{ path: path.join(tmp, "out-3.jpg"), format: "jpeg", width: 1024, height: 256, preview: { content_index: 2, width: 512, height: 128, background: "original", alpha: { has_channel: false, min: 255, max: 255 } } }], usage: { estimated_cost_usd: 0.067, requests_succeeded: 1, requests_reported: 1 } });
    expect(await fs.readFile(output.images[0].path)).toEqual(bytes);
    const block = result.content[output.images[0].preview!.content_index];
    expect(block.type).toBe("image");
    if (block.type !== "image") throw new Error("missing image");
    expect(block.mimeType).toBe("image/jpeg");
    const inline = Buffer.from(block.data, "base64");
    expect(inline.length).toBeLessThanOrEqual(200 * 1024);
    expect(await sharp(inline).metadata()).toMatchObject({ format: "jpeg", width: 512, height: 128 });
    expect(JSON.stringify(output)).not.toContain(block.data);
    expect(result.content.filter(b => b.type === "text").map(b => b.text).join(" ")).toContain("Derived JPEG preview");
    expect(result.content.filter(b => b.type === "text").map(b => b.text).join(" ")).not.toContain(block.data);
  });

  it("preserves paid partial delivery and its issue when preview processing fails", async () => {
    generateMock.mockResolvedValueOnce({ images: [{ data: IMG, mimeType: "image/jpeg", width: 1024, height: 1024 }], usage: { estimatedCostUsd: 0.067, costBasis: "per_image" } }).mockRejectedValueOnce(new ToolError(ErrorType.API_RATE_LIMIT, "Rate limit exceeded.", "Wait until capacity is available."));
    const result = await harness.callTool(TOOL, { prompt: "p", output_path: path.join(tmp, "partial.jpg"), num_images: 2, include_preview: true });
    expect(result.isError).toBeFalsy();
    expect(generateMock).toHaveBeenCalledTimes(2);
    const output = result.structuredContent as ImageToolOutput;
    expect(output).toMatchObject({ status: "partial", images: [{ path: path.join(tmp, "partial.jpg"), format: "jpeg", width: 1024, height: 1024 }], usage: { estimated_cost_usd: 0.067, requests_succeeded: 1, requests_reported: 1 }, issue: { code: "API_RATE_LIMIT", message: "Rate limit exceeded." } });
    expect(await fs.readFile(output.images[0].path)).toEqual(Buffer.from("fake-jpeg-bytes"));
    expect(output.images[0].preview_warning).toBe(`Preview unavailable: unsupported image signature or MIME type. Original saved successfully; inspect ${output.images[0].path} without repeating the image request.`);
    expect(firstText(result)).toContain(output.issue!.message);
    expect(firstText(result)).toContain(output.images[0].preview_warning);
    expect(result.content).toHaveLength(1);
  });

  it("saves every original before previews and maps later successes after a failed preview", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    generateMock.mockResolvedValue({ images: [{ data: bytes.toString("base64"), mimeType: "image/png", width: 8, height: 8 }, { data: bytes.toString("base64"), mimeType: "image/png", width: 8, height: 8 }] });
    let filesAtFirstPreview: string[] | undefined;
    vi.spyOn(previews, "createImagePreview").mockImplementationOnce(async () => {
      filesAtFirstPreview = (await fs.readdir(tmp)).sort();
      throw new Error("arbitrary native details must not leak");
    });
    const result = await harness.callTool(TOOL, { prompt: "p", model: "gpt-image-2.5-flare", output_path: path.join(tmp, "out.png"), num_images: 2, include_preview: true });
    expect(filesAtFirstPreview).toEqual(["out-2.png", "out.png"]);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ImageToolOutput;
    expect(output.images).toHaveLength(2);
    expect(output.images[0].preview_warning).toContain("image decoding or processing failed");
    expect(output.images[1].preview).toMatchObject({ content_index: 2, width: 16, height: 8, alpha: { has_channel: true, min: 128, max: 128 } });
    expect(result.content[2].type).toBe("image");
    expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining(output.images[1].path) });
    expect(firstText(result)).toContain(output.images[0].preview_warning);
    expect(firstText(result)).not.toContain("arbitrary native details");
    for (const saved of output.images) expect(await fs.readFile(saved.path)).toEqual(bytes);
  });

  it("contains an unavailable optional decoder after saving a successful result", async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).jpeg().toBuffer();
    generateMock.mockResolvedValue({ images: [{ data: bytes.toString("base64"), mimeType: "image/jpeg" }] });
    vi.doMock("sharp", () => { throw new Error("native binding cannot load"); });
    try {
      const result = await harness.callTool(TOOL, { prompt: "p", output_path: path.join(tmp, "no-decoder.jpg"), include_preview: true });
      expect(result.isError).toBeFalsy();
      const output = result.structuredContent as ImageToolOutput;
      expect(output.status).toBe("complete");
      expect(output.images[0].preview_warning).toContain("optional image decoder unavailable");
      expect(firstText(result)).toContain(output.images[0].preview_warning);
      expect(await fs.readFile(output.images[0].path)).toEqual(bytes);
      expect(generateMock).toHaveBeenCalledTimes(1);
    } finally { vi.doUnmock("sharp"); }
  });
});
