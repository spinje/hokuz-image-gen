import { afterEach, expect, it, vi } from "vitest";
import { connectTestClient, firstText } from "../../__tests__/harness.js";
import * as files from "../../services/file-utils.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn() }));
// Keep capability and credential validation real; only paid work is mocked.
vi.mock("../../providers/index.js", async (original) => ({
  ...await original<typeof import("../../providers/index.js")>(), generateImage: mocks.generate, editImage: mocks.edit,
}));
vi.mock("../../services/image-preview.js", () => ({ createImagePreview: vi.fn(), PreviewUnavailable: class extends Error {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(["gemini-3.1-flash-image", "gpt-image-2.5-flare"])("rejects missing credentials for %s before reading edit inputs", async (model) => {
  vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("GOOGLE_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
  const load = vi.spyOn(files, "loadInputImage");
  const client = await connectTestClient();
  try {
    const result = await client.callTool("hokuz_edit_image", { model, prompt: "p", output_path: "out.jpg", image_paths: ["absent.png"] });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: "failed", images: [], issue: {
      code: "MISSING_API_KEY", message: expect.stringContaining("Generation did not start"),
      next_step: expect.stringContaining(model.startsWith("gemini") ? "GEMINI_API_KEY" : "OPENAI_API_KEY"),
    } } });
    expect(firstText(result)).toContain("Generation did not start");
    expect(load).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  } finally { await client.close(); }
});
