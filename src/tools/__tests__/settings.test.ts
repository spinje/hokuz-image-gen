/**
 * The `settings` a result echoes must be what the provider was sent, including
 * the defaults the provider applied. Unlike the other tool suites this one
 * mocks the provider SDKs, not `providers/index.js`, so each test drives the
 * echo and the real request builder in the same call and compares the two.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS } from "../../constants.js";
import type { ImageToolOutput } from "../../schemas/output.js";

const sdk = vi.hoisted(() => ({ interactions: vi.fn(), generate: vi.fn(), edit: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { interactions = { create: sdk.interactions }; },
}));
vi.mock("openai", async (importOriginal) => ({
  ...await importOriginal<typeof import("openai")>(),
  default: class { images = { generate: sdk.generate, edit: sdk.edit }; },
}));
vi.stubEnv("GEMINI_API_KEY", "test-key");
vi.stubEnv("OPENAI_API_KEY", "test-key");

const { connectTestClient, firstText } = await import("../../__tests__/harness.js");

const IMG = Buffer.from("image bytes").toString("base64");
let harness: Awaited<ReturnType<typeof connectTestClient>>;
let tmp: string;
let input: string;

beforeEach(async () => {
  vi.resetAllMocks();
  sdk.interactions.mockResolvedValue({ output_image: { data: IMG, mime_type: "image/jpeg" } });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-settings-"));
  input = path.join(tmp, "in.png");
  await fs.writeFile(input, "png bytes");
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const settingsOf = (result: { structuredContent?: Record<string, unknown> }) =>
  (result.structuredContent as ImageToolOutput).settings;
const settingsLineOf = (result: Parameters<typeof firstText>[0]) =>
  firstText(result).split("\n").find((line) => line.startsWith("Settings: "));

describe("settings echo", () => {
  it("echoes the Gemini defaults the request was built with", async () => {
    const result = await harness.callTool("hokuz_generate_image", { prompt: "p", output_path: tmp });

    const [request] = sdk.interactions.mock.calls[0];
    expect(request).toMatchObject({
      model: DEFAULTS.model,
      response_format: { image_size: "1K", aspect_ratio: "1:1", mime_type: "image/jpeg" },
      generation_config: { temperature: DEFAULTS.temperature },
    });
    expect(settingsOf(result)).toEqual({
      model: DEFAULTS.model,
      aspect_ratio: request.response_format.aspect_ratio,
      resolution: request.response_format.image_size,
      output_format: "jpeg",
      temperature: request.generation_config.temperature,
    });
    expect(settingsLineOf(result)).toBe(
      "Settings: gemini-3.1-flash-image, aspect_ratio 1:1 (target), 1K, jpeg, temperature 1"
    );
  });

  it("echoes OpenAI's quality default and the transparent background it sent", async () => {
    sdk.generate.mockResolvedValue({ created: 0, data: [{ b64_json: IMG }], size: "1360x768", output_format: "png" });

    const result = await harness.callTool("hokuz_generate_image", {
      prompt: "p", output_path: path.join(tmp, "logo.png"), model: "gpt-image-2.5-flare",
      aspect_ratio: "16:9", transparent_background: true,
    });

    const [request] = sdk.generate.mock.calls[0];
    expect(request).toMatchObject({
      size: "1360x768", quality: DEFAULTS.quality, output_format: "png", background: "transparent",
    });
    expect(settingsOf(result)).toEqual({
      model: "gpt-image-2.5-flare",
      aspect_ratio: "16:9",
      resolution: "1K",
      output_format: request.output_format,
      quality: request.quality,
      transparent_background: true,
    });
    expect(settingsLineOf(result)).toBe(
      "Settings: gpt-image-2.5-flare, aspect_ratio 16:9 (target; delivered pixel size per image above), 1K, png, quality medium, transparent_background true"
    );
  });

  it("echoes an opaque OpenAI background as false rather than omitting it", async () => {
    sdk.generate.mockResolvedValue({ created: 0, data: [{ b64_json: IMG }], size: "1024x1024" });

    const result = await harness.callTool("hokuz_generate_image", {
      prompt: "p", output_path: tmp, model: "gpt-image-2.5-sunburst", quality: "high",
    });

    expect(sdk.generate.mock.calls[0][0]).toMatchObject({ quality: "high", background: "opaque" });
    expect(settingsOf(result)).toMatchObject({ quality: "high", transparent_background: false });
    expect(settingsOf(result)).not.toHaveProperty("temperature");
  });

  it("echoes edit auto as auto: Gemini still applies its resolution", async () => {
    const result = await harness.callTool("hokuz_edit_image", {
      prompt: "p", image_paths: [input], output_path: tmp,
    });

    const [request] = sdk.interactions.mock.calls[0];
    expect(request.response_format).not.toHaveProperty("aspect_ratio");
    expect(request.response_format.image_size).toBe("1K");
    expect(settingsOf(result)).toEqual({
      model: DEFAULTS.model, aspect_ratio: "auto", resolution: "1K", output_format: "jpeg",
      temperature: request.generation_config.temperature,
    });
    expect(request.generation_config.temperature).toBe(DEFAULTS.temperature);
    expect(settingsLineOf(result)).toBe("Settings: gemini-3.1-flash-image, aspect_ratio auto, 1K, jpeg, temperature 1");
  });

  it("echoes edit auto as auto with no resolution on OpenAI, which chose the size", async () => {
    sdk.edit.mockResolvedValue({ created: 0, data: [{ b64_json: IMG }], size: "1536x1024" });

    const result = await harness.callTool("hokuz_edit_image", {
      prompt: "p", image_paths: [input], output_path: tmp, model: "gpt-image-2.5-flare",
    });

    expect(sdk.edit.mock.calls[0][0]).toMatchObject({ size: "auto", quality: DEFAULTS.quality, background: "opaque" });
    expect(settingsOf(result)).toEqual({
      model: "gpt-image-2.5-flare", aspect_ratio: "auto", output_format: "jpeg",
      quality: DEFAULTS.quality, transparent_background: false,
    });
    expect(settingsLineOf(result)).toBe(
      "Settings: gpt-image-2.5-flare, aspect_ratio auto, jpeg, quality medium, transparent_background false"
    );
  });

  it("carries no settings when the call is rejected before generation", async () => {
    const result = await harness.callTool("hokuz_generate_image", {
      prompt: "p", output_path: tmp, model: "gpt-image-2.5-flare", temperature: 0.5,
    });

    expect(result.structuredContent).toMatchObject({ status: "failed", issue: { code: "INVALID_MODEL_OPTION" } });
    expect(result.structuredContent).not.toHaveProperty("settings");
    expect(settingsLineOf(result)).toBeUndefined();
    expect(sdk.generate).not.toHaveBeenCalled();
  });
});
