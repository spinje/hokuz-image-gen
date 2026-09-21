import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { connectTestClient } from "../../__tests__/harness.js";
import type { ImagePreview } from "../../services/image-preview.js";

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
});

describe("image operation admission", () => {
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
      expect(busy).toMatchObject({ isError: true, structuredContent: { error_type: "SERVER_BUSY", retryable: true, images: [] } });
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve({ data: "YQ==", width: 1, height: 1, background: "original", alpha: { has_channel: false, min: 255, max: 255 } });
      expect(await first).toMatchObject({ structuredContent: { success: true } });
    }
    expect(await b.client.callTool("hokuz_generate_image", { prompt: "p", output_path: b.output })).toMatchObject({ structuredContent: { success: true } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("releases the slot after a provider failure", async () => {
    const a = await setup();
    mocks.generate.mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce(generated);
    expect(await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output })).toMatchObject({ isError: true });
    expect(await a.client.callTool("hokuz_generate_image", { prompt: "p", output_path: a.output })).toMatchObject({ structuredContent: { success: true } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});
