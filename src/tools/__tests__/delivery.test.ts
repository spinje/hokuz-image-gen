import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as files from "../../services/file-utils.js";
import { connectTestClient, firstText } from "../../__tests__/harness.js";
import { ErrorType, ToolError } from "../../types.js";
import type { ImageToolOutput } from "../../schemas/output.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn(), preview: vi.fn() }));
vi.mock("../../providers/index.js", async (original) => ({
  ...await original<typeof import("../../providers/index.js")>(), generateImage: mocks.generate, editImage: mocks.edit,
}));
vi.mock("../../services/image-preview.js", () => ({
  createImagePreview: mocks.preview, PreviewUnavailable: class extends Error {},
}));
const image = { data: Buffer.from("image bytes").toString("base64"), mimeType: "image/jpeg" };
const response = { images: [image], usage: { estimatedCostUsd: 0.02, costBasis: "per_image" } };
let client: Awaited<ReturnType<typeof connectTestClient>>;
let dir: string;
let outputPath: string;
beforeEach(async () => {
  client = await connectTestClient();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-delivery-"));
  outputPath = path.join(dir, "image.jpg");
  mocks.generate.mockResolvedValue(response);
});
afterEach(async () => {
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.resetAllMocks();
});
const call = (num_images = 3) => client.callTool("hokuz_generate_image", { prompt: "p", output_path: outputPath, num_images });

describe("delivery and recovery", () => {
  it("saves a response before asking the provider for another image", async () => {
    mocks.generate.mockResolvedValueOnce(response).mockImplementationOnce(async () => {
      expect(await fs.readFile(outputPath, "utf8")).toBe("image bytes");
      return response;
    });
    const result = await call(2);
    expect(result.structuredContent).toMatchObject({ status: "complete" });
    expect(result.structuredContent).not.toHaveProperty("issue");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("preserves saved files and usage when a later write fails, without further generation", async () => {
    const save = files.saveBase64Image;
    vi.spyOn(files, "saveBase64Image").mockImplementationOnce(save).mockRejectedValueOnce(
      new ToolError(ErrorType.FILE_WRITE_ERROR, "Could not save the image to 'image-2.jpg'.", "Free disk space.")
    );
    const result = await call();
    const output = result.structuredContent as ImageToolOutput;
    expect(result.isError).toBeFalsy();
    expect(output).toMatchObject({ status: "partial", images: [{ path: outputPath }],
      usage: { requests_succeeded: 2, requests_reported: 2, estimated_cost_usd: 0.04 },
      issue: { code: "FILE_WRITE_ERROR", message: expect.stringContaining("only 0 were saved"),
        next_step: expect.stringContaining("cannot be retrieved through this tool") },
    });
    expect(output.images).toHaveLength(1);
    expect(output.issue!.next_step).toContain("num_images to 2");
    expect(await fs.readFile(outputPath, "utf8")).toBe("image bytes");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(firstText(result)).toContain(outputPath);
    expect(firstText(result)).toContain(output.issue!.message);
    expect(firstText(result)).toContain(output.issue!.next_step);
  });

  it("reports a first-save failure without saying generation never happened", async () => {
    vi.spyOn(files, "saveBase64Image").mockRejectedValueOnce(
      new ToolError(ErrorType.FILE_WRITE_ERROR, "Could not save the image.", "Correct output_path.")
    );
    const result = await call();
    expect(result).toMatchObject({ isError: true, structuredContent: { status: "failed", images: [],
      usage: { requests_succeeded: 1, estimated_cost_usd: 0.02 },
      issue: { message: expect.stringContaining("Generation returned 1 requested image"), next_step: expect.stringContaining("another paid request") },
    } });
    expect(firstText(result)).not.toContain("Generation did not start");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("keeps the first image when saving a second image from the same response fails", async () => {
    mocks.generate.mockResolvedValueOnce({ ...response, images: [image, image] });
    const save = files.saveBase64Image;
    vi.spyOn(files, "saveBase64Image").mockImplementationOnce(save).mockRejectedValueOnce(
      new ToolError(ErrorType.FILE_WRITE_ERROR, "Could not save image-2.jpg.", "Free disk space.")
    );
    const result = await call();
    expect(result.structuredContent).toMatchObject({ status: "partial", images: [{ path: outputPath }],
      issue: { message: expect.stringContaining("Generation returned 2 requested image(s) in this request, but only 1 were saved") },
      usage: { requests_succeeded: 1, estimated_cost_usd: 0.02 },
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty and limits recovery to missing images", async () => {
    mocks.generate.mockResolvedValueOnce(response).mockRejectedValueOnce(new ToolError(ErrorType.API_ERROR,
      "Completion and billing could not be confirmed.", "Do not automatically retry; another attempt may incur another charge."));
    const result = await call();
    const output = result.structuredContent as ImageToolOutput;
    expect(output.status).toBe("partial");
    expect(output.issue!.next_step).toContain("another charge");
    expect(output.issue!.next_step).toContain("num_images to 2");
    expect(firstText(result)).toContain(output.issue!.next_step);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("provides an actionable preflight issue in both channels without generating", async () => {
    const result = await client.callTool("hokuz_generate_image", {
      prompt: "p", output_path: outputPath, model: "gemini-3.1-flash-image", output_format: "png",
    });
    const output = result.structuredContent as ImageToolOutput;
    expect(output).toMatchObject({ status: "failed", images: [], issue: { code: "INVALID_MODEL_OPTION" } });
    expect(output.issue!.message).toContain("Generation did not start");
    expect(output.issue!.next_step).toContain("jpeg");
    expect(firstText(result)).toContain(output.issue!.message);
    expect(firstText(result)).toContain(output.issue!.next_step);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("keeps SDK validation as the boundary for malformed arguments", async () => {
    const result = await client.callTool("hokuz_generate_image", { prompt: "p", output_path: outputPath, num_images: 0 });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("num_images");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
