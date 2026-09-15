import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIError } from "openai";
import { BASE_ASPECT_RATIOS } from "../../constants.js";
import { ErrorType, McpError, type GenerationConfig } from "../../types.js";

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

const { editImage, generateImage, openaiSize } = await import("../openai.js");

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
    for (const aspectRatio of BASE_ASPECT_RATIOS) {
      for (const resolution of ["1K", "2K"] as const) {
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

describe("generateImage request shape", () => {
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
});

describe("editImage request shape", () => {
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
  });

  it("leaves width and height unset when the provider chose the size", async () => {
    generateMock.mockResolvedValue(okResponse({ size: "auto" }));

    const [image] = (await generateImage("p", baseConfig)).images;

    expect(image.data).toBe(IMG_A);
    expect(image.width).toBeUndefined();
    expect(image.height).toBeUndefined();
  });

  it("raises API_ERROR when the response carries no image", async () => {
    generateMock.mockResolvedValue(okResponse({ data: [] }));

    await expect(generateImage("p", baseConfig)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.API_ERROR,
        message: "Error: OpenAI returned no image for this request. Retry, or rephrase the prompt.",
      })
    );
  });
});

describe("API error mapping", () => {
  const cases: Array<[number, ErrorType, RegExp]> = [
    [401, ErrorType.MISSING_API_KEY, /rejected the API key \(401\).*Check OPENAI_API_KEY/],
    [403, ErrorType.API_ERROR, /denied access \(403\).*organisation verification/],
    [404, ErrorType.API_ERROR, /model 'gpt-image-2\.5-flare' was not found/],
    [429, ErrorType.API_RATE_LIMIT, /rate limit exceeded \(429\).*lower num_images/],
    [500, ErrorType.API_ERROR, /request failed \(500\).*try the other provider/],
  ];

  for (const [status, type, pattern] of cases) {
    it(`maps HTTP ${status} to ${type}`, async () => {
      generateMock.mockRejectedValue(apiError(status, { message: "boom" }));
      await expect(generateImage("p", baseConfig)).rejects.toThrowError(
        expect.objectContaining({ type, message: expect.stringMatching(pattern) })
      );
    });
  }

  it("maps a moderation refusal to CONTENT_BLOCKED with the stage and categories", async () => {
    generateMock.mockRejectedValue(
      apiError(400, {
        message: "Your request was rejected.",
        code: "moderation_blocked",
        moderation_details: {
          moderation_stage: "input",
          categories: ["violence", "self-harm"],
        },
      })
    );

    await expect(generateImage("p", baseConfig)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.CONTENT_BLOCKED,
        message:
          "Error: OpenAI's content moderation blocked this request (input; categories: violence, self-harm). Rephrase the prompt or change the input images.",
      })
    );
  });

  it("tells an edit caller which input formats are accepted on an unclassified 4xx", async () => {
    editMock.mockRejectedValue(apiError(400, { message: "Invalid file" }));

    await expect(
      editImage("p", [{ data: IMG_A, mimeType: "image/gif" }], baseConfig)
    ).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.API_ERROR,
        message:
          "Error: OpenAI rejected the request: Invalid file. Adjust the arguments accordingly; input images must be jpeg, png or webp.",
      })
    );

    // Generate has no input images, so the hint must not appear there.
    generateMock.mockRejectedValue(apiError(400, { message: "Invalid value" }));
    await expect(generateImage("p", baseConfig)).rejects.toThrowError(
      expect.objectContaining({
        message:
          "Error: OpenAI rejected the request: Invalid value. Adjust the arguments accordingly.",
      })
    );
  });

  it("maps a connection failure with no status to a retryable API_ERROR", async () => {
    generateMock.mockRejectedValue(new Error("socket hang up"));

    await expect(generateImage("p", baseConfig)).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.API_ERROR,
        message:
          "Error: OpenAI request failed (network): socket hang up. Retry; if it persists, try the other provider.",
      })
    );
  });

  it("re-throws McpErrors raised inside the request path with their original message", async () => {
    // parseImagesResponse throws API_ERROR when no image came back. Without the
    // instanceof guard the heuristics below would rewrap it and lose the text.
    generateMock.mockResolvedValue(okResponse({ data: undefined }));

    await expect(generateImage("p", baseConfig)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof McpError &&
        e.message === "Error: OpenAI returned no image for this request. Retry, or rephrase the prompt."
    );
  });
});

describe("API key resolution", () => {
  it("names the model that cannot run, without constructing a client", async () => {
    vi.resetModules();
    ctorMock.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
    const { generateImage } = await import("../openai.js");

    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({
      type: ErrorType.MISSING_API_KEY,
      message:
        "Error: OPENAI_API_KEY is not set, so 'gpt-image-2.5-flare' cannot be used. Set OPENAI_API_KEY in the MCP server's environment, or choose a Gemini model.",
    });
    expect(ctorMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();

    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });
});
