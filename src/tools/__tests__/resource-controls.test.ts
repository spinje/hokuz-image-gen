import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { connectTestClient } from "../../__tests__/harness.js";
import type { ImagePreview } from "../../services/image-preview.js";
import { acquireImageOperation } from "../../services/image-operation.js";
import { runImageTool } from "../image-tool.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn(), preview: vi.fn() }));
vi.mock("../../providers/index.js", async (original) => ({
  ...await original<typeof import("../../providers/index.js")>(),
  generateImage: mocks.generate, editImage: mocks.edit,
}));
// No native decoder is loaded in this suite.
vi.mock("../../services/image-preview.js", () => ({
  createImagePreview: mocks.preview, PreviewUnavailable: class extends Error {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const generated = { images: [{ data: Buffer.from("tiny fixture").toString("base64"), mimeType: "image/jpeg" }] };
const clients: Awaited<ReturnType<typeof connectTestClient>>[] = [];
const directories: string[] = [];
async function setup() {
  const client = await connectTestClient(); clients.push(client);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-controls-")); directories.push(dir);
  return { client, output: path.join(dir, "out.jpg") };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("image operation admission", () => {
  it("rejects an out-of-root destination before any provider call", async () => {
    const a = await setup(); const b = await setup();
    vi.stubEnv("HOKUZ_OUTPUT_ROOT", path.dirname(a.output));
    mocks.generate.mockResolvedValue(generated);
    const rejected = await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: b.output });
    expect(rejected).toMatchObject({ isError: true, structuredContent: { issue: { code: "FILE_WRITE_ERROR" } } });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output })).toMatchObject({ structuredContent: { status: "complete" } });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("holds the shared slot through preview work and rejects edit before reading its input", async () => {
    const a = await setup(); const b = await setup();
    mocks.generate.mockResolvedValue(generated);
    const entered = deferred<void>(); const finish = deferred<ImagePreview>();
    mocks.preview.mockImplementation(() => { entered.resolve(); return finish.promise; });
    const first = a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output, include_preview: true });
    await entered.promise;
    try {
      const busy = await b.client.callTool("hokuz_edit_image", {
        prompt: "p", output_path: b.output, image_paths: [path.join(path.dirname(b.output), "absent.png")],
      });
      expect(busy).toMatchObject({ isError: true, structuredContent: { issue: { code: "SERVER_BUSY" }, images: [] } });
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve({ data: "YQ==", width: 1, height: 1, background: "original", alpha: { has_channel: false, min: 255, max: 255 } });
      expect(await first).toMatchObject({ structuredContent: { status: "complete" } });
    }
    expect(await b.client.callTool("hokuz_generate_image", { prompt: "p", output_path: b.output })).toMatchObject({ structuredContent: { status: "complete" } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("releases the slot after a provider failure", async () => {
    const a = await setup();
    mocks.generate.mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce(generated);
    expect(await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output })).toMatchObject({ isError: true });
    expect(await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output })).toMatchObject({ structuredContent: { status: "complete" } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});

describe("request cancellation", () => {
  it("forwards cancellation into an active preview while retaining the slot and saved original", async () => {
    const a = await setup(); const entered = deferred<AbortSignal>(); const finish = deferred<ImagePreview>();
    mocks.generate.mockResolvedValue(generated);
    mocks.preview.mockImplementation((_data, _mime, signal: AbortSignal) => {
      entered.resolve(signal);
      return finish.promise; // A running native stage cannot be interrupted by JS.
    });
    const controller = new AbortController();
    const call = a.client.client.callTool({ name: "hokuz_generate_image", arguments: {
      prompt: "p", output_path: a.output, include_preview: true,
    } }, undefined, { signal: controller.signal });
    const rejected = expect(call).rejects.toBeDefined();
    const previewSignal = await entered.promise;
    try {
      expect(previewSignal.aborted).toBe(false);
      expect(await fs.readFile(a.output, "utf8")).toBe("tiny fixture");
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(previewSignal.aborted).toBe(true));
      expect(acquireImageOperation).toThrow("already processing");
    } finally {
      controller.abort();
      finish.resolve({ data: "YQ==", width: 1, height: 1, background: "original", alpha: { has_channel: false, min: 255, max: 255 } });
    }
    await vi.waitFor(() => { const release = acquireImageOperation(); release(); });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it("forwards MCP cancellation to the provider and releases the slot", async () => {
    const a = await setup(); const entered = deferred<AbortSignal>();
    mocks.generate.mockImplementation((_prompt, _config, signal: AbortSignal) => {
      entered.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const controller = new AbortController();
    const call = a.client.client.callTool({ name: "hokuz_generate_image", arguments: { prompt: "p", output_path: a.output } }, undefined, { signal: controller.signal });
    const rejected = expect(call).rejects.toBeDefined();
    const providerSignal = await entered.promise;
    expect(providerSignal.aborted).toBe(false);
    controller.abort();
    await rejected;
    await vi.waitFor(() => {
      expect(providerSignal.aborted).toBe(true);
      const release = acquireImageOperation(); release();
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("saves a returned paid result but stops subsequent requests and previews", async () => {
    const a = await setup(); const controller = new AbortController();
    const produce = vi.fn(async () => { controller.abort(); return generated; });
    const result = await runImageTool({
      outputFormat: "jpeg", outputPath: a.output, requestedCount: 3, includePreview: true,
      signal: controller.signal, produce,
    });
    expect(result.structuredContent).toMatchObject({ status: "partial", issue: { code: "REQUEST_CANCELLED", message: expect.stringContaining("cancelled") } });
    expect(await fs.readFile(a.output, "utf8")).toBe("tiny fixture");
    expect(produce).toHaveBeenCalledTimes(1);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
