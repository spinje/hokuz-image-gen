import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIConnectionError, APIError } from "openai";
import { IMAGE_MODEL_CAPABILITIES } from "../../constants.js";
import { ErrorType, ToolError, type GenerationConfig } from "../../types.js";

const FLARE = IMAGE_MODEL_CAPABILITIES["gpt-image-2.5-flare"];

const { generateMock, editMock, ctorMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  editMock: vi.fn(),
  ctorMock: vi.fn(),
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class {
      images = { generate: generateMock, edit: editMock };
      constructor(options: unknown) {
        ctorMock(options);
      }
    },
  };
});

vi.stubEnv("OPENAI_API_KEY", "test-key");

const { editImage, expectedSize, generateImage, openaiSize } = await import("../openai.js");

const IMG_A = Buffer.from("image-a").toString("base64");
const IMG_B = Buffer.from("image-b").toString("base64");

const baseConfig: GenerationConfig = {
  model: "gpt-image-2.5-flare",
  aspectRatio: "16:9",
  resolution: "1K",
  outputFormat: "jpeg",
  quality: "medium",
};

/** A minimal successful Images API response. */
const okResponse = (overrides: Record<string, unknown> = {}) => ({
  created: 0,
  data: [{ b64_json: IMG_A }],
  size: "1360x768",
  ...overrides,
});

/** Build a real APIError the way the SDK does from a response body. */
function apiError(status: number, body: Record<string, unknown>) {
  return APIError.generate(status, { error: body }, undefined, new Headers());
}

beforeEach(() => {
  generateMock.mockReset();
  editMock.mockReset();
});

describe("openaiSize", () => {
  // Spot checks against the plan's computed table; the sweep below covers the
  // invariants the API enforces for every other combination.
  it.each([
    ["1:1", "1K", "1024x1024"],
    ["16:9", "1K", "1360x768"],
    ["21:9", "2K", "3136x1344"],
  ] as const)("derives %s at %s as %s", (aspectRatio, resolution, expected) => {
    expect(openaiSize({ ...baseConfig, aspectRatio, resolution })).toBe(expected);
  });

  it("returns 'auto' when the config has no aspect ratio (edit 'auto')", () => {
    expect(openaiSize({ ...baseConfig, aspectRatio: undefined })).toBe("auto");
  });

  it("keeps every supported ratio x resolution inside the API's size rules", () => {
    for (const aspectRatio of FLARE.aspectRatios) {
      for (const resolution of FLARE.resolutions) {
        const size = openaiSize({ ...baseConfig, aspectRatio, resolution });
        const [width, height] = size.split("x").map(Number);
        expect({ aspectRatio, resolution, mod: [width % 16, height % 16] }).toEqual({
          aspectRatio,
          resolution,
          mod: [0, 0],
        });
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
        expect(width * height).toBeGreaterThanOrEqual(655_360);
        expect(width * height).toBeLessThanOrEqual(8_294_400);
        expect(width / height).toBeGreaterThanOrEqual(1 / 3);
        expect(width / height).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("expectedSize", () => {
  it("is the size the request is sent with, for every model, ratio and resolution", () => {
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      for (const aspectRatio of caps.aspectRatios) {
        for (const resolution of caps.resolutions) {
          const config = { ...baseConfig, model, aspectRatio, resolution };
          expect({ model, aspectRatio, resolution, size: expectedSize(config) })
            .toEqual({ model, aspectRatio, resolution, size: openaiSize(config) });
        }
      }
    }
  });

  it("applies the default resolution the request applies, and is absent when the provider chooses", () => {
    expect(expectedSize({ ...baseConfig, resolution: undefined })).toBe("1360x768");
    expect(expectedSize({ ...baseConfig, aspectRatio: undefined, resolution: undefined })).toBeUndefined();
  });
});

describe("generateImage request shape", () => {
  it("forwards cancellation to the SDK and does not submit already-cancelled work", async () => {
    const controller = new AbortController();
    generateMock.mockResolvedValue(okResponse());
    await generateImage("p", baseConfig, controller.signal);
    expect(generateMock.mock.calls[0][1]).toEqual({ signal: controller.signal, maxRetries: 0 });
    controller.abort();
    await expect(generateImage("p", baseConfig, controller.signal)).rejects.toMatchObject({ issue: expect.objectContaining({ code: ErrorType.REQUEST_CANCELLED }) });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
  it("sends one image at the derived size with an explicit quality and background", async () => {
    generateMock.mockResolvedValue(okResponse());

    await generateImage("a prompt", baseConfig);

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "a prompt",
      n: 1,
      size: "1360x768",
      quality: "medium",
      output_format: "jpeg",
      background: "opaque",
    });
  });

  it("asks for a transparent background and the requested format when told to", async () => {
    generateMock.mockResolvedValue(okResponse({ size: "1024x1024" }));

    const response = await generateImage("a prompt", {
      ...baseConfig,
      aspectRatio: "1:1",
      outputFormat: "png",
      transparentBackground: true,
    });

    expect(generateMock.mock.calls[0][0]).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "a prompt",
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
      background: "transparent",
    });
    // The saved file's MIME type follows the requested format, not the default.
    expect(response.images[0].mimeType).toBe("image/png");
  });

  it("applies its own defaults when the config carries no quality or resolution", async () => {
    generateMock.mockResolvedValue(okResponse());

    await generateImage("a prompt", {
      ...baseConfig,
      aspectRatio: "1:1",
      resolution: undefined,
      quality: undefined,
    });

    expect(generateMock.mock.calls[0][0]).toMatchObject({
      size: "1024x1024",
      quality: "medium",
    });
  });
});

describe("editImage request shape", () => {
  it("sends the size derived from the config alongside the uploaded image", async () => {
    editMock.mockResolvedValue(okResponse());

    await editImage("make it blue", [{ data: IMG_A, mimeType: "image/png" }], baseConfig);

    const { image, ...request } = editMock.mock.calls[0][0];
    expect(request).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "make it blue",
      n: 1,
      size: "1360x768",
      quality: "medium",
      output_format: "jpeg",
      background: "opaque",
    });
    expect((image as File[]).map((f) => [f.name, f.type])).toEqual([
      ["image-1.png", "image/png"],
    ]);
  });

  it("uploads the input images in order with an explicit MIME type", async () => {
    editMock.mockResolvedValue(okResponse());

    await editImage(
      "make it blue",
      [
        { data: IMG_A, mimeType: "image/png" },
        { data: IMG_B, mimeType: "image/webp" },
      ],
      { ...baseConfig, aspectRatio: undefined }
    );

    const request = editMock.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "gpt-image-2.5-flare",
      prompt: "make it blue",
      n: 1,
      size: "auto",
      quality: "medium",
      output_format: "jpeg",
      background: "opaque",
    });
    // A buffer without an explicit type is uploaded as application/octet-stream
    // and rejected by the API, so both the order and the type are asserted.
    const files = request.image as File[];
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["image-1.png", "image/png"],
      ["image-2.webp", "image/webp"],
    ]);
    expect(Buffer.from(await files[0].arrayBuffer()).toString("base64")).toBe(IMG_A);
  });
});

describe("response parsing", () => {
  it("reports the returned pixel size and the cost estimated from token counts", async () => {
    generateMock.mockResolvedValue(
      okResponse({
        usage: {
          input_tokens: 1039,
          input_tokens_details: { text_tokens: 15, image_tokens: 1024 },
          output_tokens: 229,
          total_tokens: 1268,
        },
      })
    );

    const response = await generateImage("p", baseConfig);

    expect(response.images).toEqual([
      { data: IMG_A, mimeType: "image/jpeg", width: 1360, height: 768 },
    ]);
    // 15 text @ $5/M + 1024 image @ $8/M + 229 output @ $30/M per million tokens.
    expect(response.usage?.inputTokens).toBe(1039);
    expect(response.usage?.outputTokens).toBe(229);
    expect(response.usage?.estimatedCostUsd).toBeCloseTo(0.015137, 9);
    // The counts above are what produced that cost, unlike Gemini's per-image price.
    expect(response.usage?.costBasis).toBe("tokens");
  });

  it("reports the size the provider chose for an edit sent with size 'auto'", async () => {
    // The live API echoes the real WxH it picked, not the literal "auto".
    editMock.mockResolvedValue(okResponse({ size: "1668x943" }));

    const [image] = (
      await editImage("p", [{ data: IMG_A, mimeType: "image/png" }], {
        ...baseConfig,
        aspectRatio: undefined,
        resolution: undefined,
      })
    ).images;

    expect(image.width).toBe(1668);
    expect(image.height).toBe(943);
  });

  it("leaves width and height unset when the response size cannot be parsed", async () => {
    generateMock.mockResolvedValue(okResponse({ size: "auto" }));

    const [image] = (await generateImage("p", baseConfig)).images;

    expect(image.data).toBe(IMG_A);
    expect(image.width).toBeUndefined();
    expect(image.height).toBeUndefined();
  });

  it("returns the billed image with usage unknown when the breakdown is missing", async () => {
    generateMock.mockResolvedValue(
      okResponse({ usage: { input_tokens: 1039, output_tokens: 229, total_tokens: 1268 } })
    );

    const response = await generateImage("p", baseConfig);

    expect(response.images).toHaveLength(1);
    expect(response.usage).toBeUndefined();
  });

  it("refuses an unexpected format but preserves the returned usage", async () => {
    generateMock.mockResolvedValue(okResponse({ output_format: "png", usage: {
      input_tokens: 12, output_tokens: 20, input_tokens_details: { text_tokens: 2, image_tokens: 10 },
    } }));
    await expect(generateImage("p", baseConfig)).resolves.toMatchObject({
      images: [], issue: { code: ErrorType.API_ERROR, message: expect.stringContaining("png instead of the requested jpeg") },
      usage: { inputTokens: 12, outputTokens: 20, estimatedCostUsd: 0.00069 },
    });
  });

  it("returns a completed response without images for the pipeline to explain", async () => {
    generateMock.mockResolvedValue(okResponse({ data: [] }));
    await expect(generateImage("p", baseConfig)).resolves.toEqual({ images: [], usage: undefined });
  });
});

describe("API error mapping", () => {
  it.each([
    [401, ErrorType.MISSING_API_KEY, "credentials"],
    [403, ErrorType.API_ERROR, "account's access"],
    [404, ErrorType.API_ERROR, "available to the configured account"],
    [429, ErrorType.API_RATE_LIMIT, "after capacity is available"],
  ])("gives appropriate recovery for HTTP %s", async (status, code, action) => {
    generateMock.mockRejectedValue(apiError(status as number, { message: "boom" }));
    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({ issue: {
      code, next_step: expect.stringContaining(action as string),
    } });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
  });

  it("classifies explicit moderation separately from request validation", async () => {
    generateMock.mockRejectedValue(apiError(400, { message: "Rejected", code: "moderation_blocked" }));
    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({ issue: {
      code: ErrorType.CONTENT_BLOCKED, message: expect.stringContaining("moderation blocked"),
      next_step: expect.stringContaining("Revise the prompt"),
    } });
    generateMock.mockRejectedValue(apiError(400, { message: "Invalid size" }));
    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({ issue: {
      code: ErrorType.API_ERROR, message: "OpenAI rejected the request. Invalid size",
      next_step: expect.stringContaining("Correct the request"),
    } });
  });

  it("does not tell an exhausted-quota account merely to wait", async () => {
    generateMock.mockRejectedValue(apiError(429, { message: "Quota exceeded", code: "insufficient_quota" }));
    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({ issue: {
      code: ErrorType.API_RATE_LIMIT, next_step: expect.stringContaining("restore quota or billing capacity"),
    } });
  });

  it.each([500, 408, 409, undefined])("preserves outcome uncertainty for %s", async (status) => {
    generateMock.mockRejectedValue(status === undefined
      ? new APIConnectionError({ message: "socket details" }) : apiError(status, { message: "server details" }));
    const error = await generateImage("p", baseConfig).catch(e => e as ToolError);
    expect(error).toMatchObject({ issue: {
      code: ErrorType.API_ERROR, message: expect.stringContaining("Completion and billing could not be confirmed"),
      next_step: expect.stringContaining("may also incur a charge"),
    } });
    expect(error).toBeInstanceOf(ToolError);
    expect(JSON.stringify((error as ToolError).issue)).not.toContain("details");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a confirmed rejection even when cancellation races with it", async () => {
    const controller = new AbortController();
    generateMock.mockImplementation(() => {
      controller.abort();
      throw apiError(400, { code: "moderation_blocked", message: "Rejected by moderation" });
    });
    await expect(generateImage("p", baseConfig, controller.signal)).rejects.toMatchObject({ issue: {
      code: ErrorType.CONTENT_BLOCKED, message: expect.stringContaining("moderation blocked"),
    } });
  });

  it("distinguishes cancellation in flight from a request that never started", async () => {
    const controller = new AbortController();
    generateMock.mockImplementation(() => { controller.abort(); throw new Error("aborted"); });
    await expect(generateImage("p", baseConfig, controller.signal)).rejects.toMatchObject({ issue: {
      code: ErrorType.REQUEST_CANCELLED, message: expect.stringContaining("Completion and billing could not be confirmed"),
      next_step: expect.stringContaining("Do not automatically retry"),
    } });
    generateMock.mockClear();
    await expect(generateImage("p", baseConfig, controller.signal)).rejects.toMatchObject({ issue: expect.objectContaining({ code: ErrorType.REQUEST_CANCELLED }) });
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("API key resolution", () => {
  it("names the model that cannot run, without constructing a client", async () => {
    vi.resetModules();
    ctorMock.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
    const { generateImage } = await import("../openai.js");

    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({
      issue: expect.objectContaining({ code: ErrorType.MISSING_API_KEY }),
      message: "The server has no OpenAI API key, so 'gpt-image-2.5-flare' cannot be used.",
    });
    expect(ctorMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();

    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  it("builds the client with OPENAI_API_KEY when it is set", async () => {
    vi.resetModules();
    ctorMock.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { generateImage } = await import("../openai.js");
    generateMock.mockResolvedValue(okResponse());

    await generateImage("p", baseConfig);

    // logLevel is pinned so an ambient OPENAI_LOG cannot log to stdout, which
    // carries the MCP protocol.
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "test-key", logLevel: "warn" });
  });
});
