import { afterEach, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const { edit } = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock("../../constants.js", async original => {
  const actual = await original<typeof import("../../constants.js")>();
  // Exercise the real loaders and shared budget with bytes, not giant fixtures.
  return { ...actual, LIMITS: { ...actual.LIMITS, maxTotalInputImageBytes: 8 } };
});
vi.mock("../../providers/index.js", async original => ({
  ...await original<typeof import("../../providers/index.js")>(), requireProviderKey: vi.fn(), editImage: edit,
}));
vi.mock("../../services/image-preview.js", () => ({
  createImagePreview: () => { throw new Error("decoder must not run"); }, PreviewUnavailable: class extends Error {},
}));
const { connectTestClient } = await import("../../__tests__/harness.js");
let client: Awaited<ReturnType<typeof connectTestClient>> | undefined;
let tmp: string | undefined;
afterEach(async () => { await client?.close(); if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

it("shares one input-byte budget across references and rejects before the provider", async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-budget-")); client = await connectTestClient();
  const first = path.join(tmp, "first.png"); const second = path.join(tmp, "second.png");
  await fs.writeFile(first, "12345"); await fs.writeFile(second, "67890");
  edit.mockResolvedValue({ images: [{ data: "YQ==", mimeType: "image/jpeg" }] });
  const args = { prompt: "p", image_paths: [first, second], output_path: path.join(tmp, "out.jpg") };
  expect(await client.callTool("hokuz_edit_image", args)).toMatchObject({ isError: true, structuredContent: { issue: { code: "IMAGE_TOO_LARGE" } } });
  expect(edit).not.toHaveBeenCalled();
  expect(await client.callTool("hokuz_edit_image", { ...args, image_paths: [first] })).toMatchObject({ structuredContent: { status: "complete" } });
  expect(edit).toHaveBeenCalledTimes(1);
});
