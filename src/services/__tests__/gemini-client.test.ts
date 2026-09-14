import { describe, it, expect, beforeEach, vi } from "vitest";
import { ErrorType, McpError } from "../../types.js";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: createMock };
  },
}));

vi.stubEnv("GEMINI_API_KEY", "test-key");

const {
  editImage,
  generateImage,
  parseInteraction,
} = await import("../gemini-client.js");

const IMG_A = Buffer.from("image-a").toString("base64");
const IMG_B = Buffer.from("image-b").toString("base64");

const baseConfig = {
  model: "gemini-3.1-flash-image" as const,
  aspectRatio: "16:9" as const,
  resolution: "1K" as const,
  temperature: 0.7,
  outputFormat: "jpeg" as const,
};

beforeEach(() => {
  createMock.mockReset();
});

describe("parseInteraction", () => {
  it("reads output_image first and de-duplicates it against step content", () => {
    const result = parseInteraction({
      output_image: { data: IMG_A, mime_type: "image/jpeg" },
      steps: [
        {
          type: "model_output",
          content: [
            { type: "image", data: IMG_A, mime_type: "image/jpeg" },
            { type: "text", text: "A caption" },
          ],
        },
      ],
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({ data: IMG_A, mimeType: "image/jpeg" });
    expect(result.description).toBe("A caption");
  });

  it("collects additional distinct images from steps", () => {
    const result = parseInteraction({
      output_image: { data: IMG_B },
      steps: [
        {
          type: "model_output",
          content: [
            { type: "image", data: IMG_A },
            { type: "image", data: IMG_B },
          ],
        },
      ],
    });
    expect(result.images.map((i) => i.data)).toEqual([IMG_B, IMG_A]);
    expect(result.images[0].mimeType).toBe("image/jpeg");
  });

  it("ignores non-model_output steps and joins multiple text blocks", () => {
    const result = parseInteraction({
      steps: [
        { type: "tool_call", content: [{ type: "image", data: IMG_A }] },
        {
          type: "model_output",
          content: [
            { type: "text", text: "one" },
            { type: "image", data: IMG_B },
            { type: "text", text: "two" },
          ],
        },
      ],
    });
    expect(result.images.map((i) => i.data)).toEqual([IMG_B]);
    expect(result.description).toBe("one\ntwo");
  });

  it("falls back to output_text when steps carry no text", () => {
    const result = parseInteraction({
      output_image: { data: IMG_A },
      output_text: "fallback",
    });
    expect(result.description).toBe("fallback");
  });

  it("throws CONTENT_BLOCKED when no image is present", () => {
    expect(() => parseInteraction({ output_text: "refused" })).toThrowError(
      expect.objectContaining({ type: ErrorType.CONTENT_BLOCKED })
    );
  });
});

describe("generateImage request shape", () => {
  it("puts image options in response_format and only temperature in generation_config", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });

    await generateImage("a prompt", { ...baseConfig, resolution: "0.5K" });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0][0];
    expect(request).toEqual({
      model: "gemini-3.1-flash-image",
      input: "a prompt",
      response_format: {
        type: "image",
        image_size: "512",
        mime_type: "image/jpeg",
        aspect_ratio: "16:9",
      },
      generation_config: { temperature: 0.7 },
    });
  });

  it("omits aspect_ratio entirely when the config has none", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });

    await generateImage("a prompt", { ...baseConfig, aspectRatio: undefined });

    const { response_format } = createMock.mock.calls[0][0];
    expect(response_format).not.toHaveProperty("aspect_ratio");
  });

  it("validates before calling the API", async () => {
    await expect(
      generateImage("a prompt", { ...baseConfig, model: "gemini-3-pro-image", aspectRatio: "1:4" })
    ).rejects.toThrowError(expect.objectContaining({ type: ErrorType.INVALID_MODEL_OPTION }));
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("editImage request shape", () => {
  it("sends input images in order, then the prompt as the last block", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });

    await editImage(
      "make it blue",
      [
        { data: IMG_A, mimeType: "image/png" },
        { data: IMG_B, mimeType: "image/webp" },
      ],
      baseConfig
    );

    const { input } = createMock.mock.calls[0][0];
    expect(input).toEqual([
      { type: "image", mime_type: "image/png", data: IMG_A },
      { type: "image", mime_type: "image/webp", data: IMG_B },
      { type: "text", text: "make it blue" },
    ]);
  });
});

describe("API error mapping", () => {
  const cases: Array<[string, ErrorType]> = [
    ["429 Too Many Requests", ErrorType.API_RATE_LIMIT],
    ["Rate limit exceeded for project", ErrorType.API_RATE_LIMIT],
    ["403 PERMISSION_DENIED", ErrorType.MISSING_API_KEY],
    ["API key not valid", ErrorType.MISSING_API_KEY],
    ["Response was blocked due to SAFETY", ErrorType.CONTENT_BLOCKED],
    ["socket hang up", ErrorType.API_ERROR],
  ];

  for (const [message, type] of cases) {
    it(`maps "${message}" to ${type}`, async () => {
      createMock.mockRejectedValue(new Error(message));
      await expect(generateImage("p", baseConfig)).rejects.toThrowError(
        expect.objectContaining({ type })
      );
    });
  }

  it("re-throws McpErrors raised inside the request path with their original message", async () => {
    // parseInteraction throws CONTENT_BLOCKED when the response has no image.
    // Without the instanceof guard in handleApiError the heuristic would still
    // classify it as CONTENT_BLOCKED (the message contains "blocked"), so the
    // type alone cannot detect the regression; the exact message can.
    createMock.mockResolvedValue({ output_text: "no image" });
    await expect(generateImage("p", baseConfig)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof McpError &&
        e.type === ErrorType.CONTENT_BLOCKED &&
        e.message.startsWith("Error: No images were generated.")
    );
  });
});

describe("API key resolution", () => {
  // A fresh module instance per case: the client is a module-level singleton,
  // so the key it was built with is only observable on first construction.
  const ctorMock = vi.fn();

  async function freshGenerate() {
    vi.resetModules();
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        interactions = { create: createMock };
        constructor(opts: unknown) {
          ctorMock(opts);
        }
      },
    }));
    const mod = await import("../gemini-client.js");
    return mod;
  }

  beforeEach(() => {
    ctorMock.mockReset();
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });
  });

  it("prefers GEMINI_API_KEY over GOOGLE_API_KEY when both are set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    const { generateImage } = await freshGenerate();
    await generateImage("p", baseConfig);
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "gemini-key" });
  });

  it("falls back to GOOGLE_API_KEY", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    const { generateImage } = await freshGenerate();
    await generateImage("p", baseConfig);
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "google-key" });
  });

  it("validateApiKey throws MISSING_API_KEY when neither is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const { validateApiKey } = await freshGenerate();
    expect(() => validateApiKey()).toThrowError(
      expect.objectContaining({ type: ErrorType.MISSING_API_KEY })
    );
  });
});
