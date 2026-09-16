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
} = await import("../gemini.js");

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
    // output_text is the SDK's concatenation of the step text; it must only be
    // used when the steps carried none, or every description would double.
    const result = parseInteraction({
      output_image: { data: IMG_A, mime_type: "image/jpeg" },
      output_text: "A caption",
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

describe("image dimensions", () => {
  /**
   * SOI, a minimal APP0 segment, a Huffman table, then a SOF segment carrying
   * the size. The provider reads the size out of the bytes because the API
   * reports none. The DHT is load-bearing: its marker (0xC4) sits inside the
   * 0xC0-0xCF range, so a walk that does not exclude it would read the size out
   * of Huffman bytes and report an invented one.
   */
  function jpeg(sofMarker: number, width: number, height: number): string {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x11, 0x22, 0x33]);
    const sof = Buffer.alloc(11);
    sof.writeUInt8(0xff, 0);
    sof.writeUInt8(sofMarker, 1);
    sof.writeUInt16BE(9, 2); // segment length
    sof.writeUInt8(8, 4); // sample precision
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof.writeUInt8(1, 9); // component count
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app0,
      dht,
      sof,
      Buffer.alloc(16), // trailing bytes the walk never reaches
    ]).toString("base64");
  }

  it("reports the JPEG's pixel size, baseline or progressive, and none for other bytes", () => {
    for (const sofMarker of [0xc0, 0xc2]) {
      const result = parseInteraction({
        output_image: { data: jpeg(sofMarker, 1360, 768), mime_type: "image/jpeg" },
      });
      expect(result.images[0]).toMatchObject({ width: 1360, height: 768 });
    }

    // Bytes that are not a JPEG the walk can follow carry no size at all.
    const notAJpeg = parseInteraction({
      output_image: { data: IMG_A, mime_type: "image/jpeg" },
    });
    expect(notAJpeg.images[0]).toEqual({ data: IMG_A, mimeType: "image/jpeg" });
  });

  it("reports no size rather than a 0x0 one when the segment reads as zero", () => {
    // The response text drops a zero edge as falsy, so publishing it in
    // structuredContent alone would make the two channels disagree.
    const zeroSized = parseInteraction({
      output_image: { data: jpeg(0xc0, 0, 768), mime_type: "image/jpeg" },
    });
    const [image] = zeroSized.images;
    expect(image).not.toHaveProperty("width");
    expect(image).not.toHaveProperty("height");
    expect(image.data).toBeTruthy();
  });
});

describe("usage and estimated cost", () => {
  // Copied from a live Lite 1K generate. The token counts cannot price the
  // image (0.5K and 1K report the same 1120 output image tokens), which is why
  // the cost comes from the per-image table instead.
  const USAGE = {
    total_tokens: 1490,
    total_input_tokens: 9,
    total_output_tokens: 1481,
    output_tokens_by_modality: [{ modality: "image", tokens: 1120 }],
  };

  it("reports the token counts with Google's per-image price", () => {
    const result = parseInteraction({ output_image: { data: IMG_A }, usage: USAGE }, 0.0336);
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 1481,
      estimatedCostUsd: 0.0336,
    });

    // One interaction can carry more than one image, and Google charges per
    // image, so the cost follows the count rather than the single request.
    const two = parseInteraction(
      {
        output_image: { data: IMG_A },
        steps: [{ type: "model_output", content: [{ type: "image", data: IMG_B }] }],
        usage: USAGE,
      },
      0.0336
    );
    expect(two.images).toHaveLength(2);
    expect(two.usage?.estimatedCostUsd).toBe(0.0672);
  });

  it("still returns the image when the response reports no usage", () => {
    const result = parseInteraction({ output_image: { data: IMG_A } }, 0.0336);
    expect(result.usage).toBeUndefined();
    expect(result.images).toHaveLength(1);
  });

  it("reports no usage rather than a NaN cost when no price is known", () => {
    // Unreachable in production (validation plus the constants invariant), so
    // this pins the choice not to publish a cost the module cannot stand behind.
    const result = parseInteraction({ output_image: { data: IMG_A }, usage: USAGE });
    expect(result.usage).toBeUndefined();
    expect(result.images).toHaveLength(1);
  });

  it("prices each request at the model and resolution it was sent with", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A }, usage: USAGE });

    const oneK = await generateImage("p", baseConfig);
    expect(oneK.usage?.estimatedCostUsd).toBe(0.067);

    const fourK = await generateImage("p", { ...baseConfig, resolution: "4K" });
    expect(fourK.usage?.estimatedCostUsd).toBe(0.151);

    // An edit may carry no resolution ("auto"); the request is built with the
    // provider's default, so that is the resolution the price must come from.
    const auto = await editImage(
      "p",
      [{ data: IMG_B, mimeType: "image/png" }],
      { ...baseConfig, resolution: undefined }
    );
    expect(auto.usage?.estimatedCostUsd).toBe(0.067);
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

  it("applies its own defaults when the config carries no resolution or temperature", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });

    await generateImage("a prompt", {
      ...baseConfig,
      resolution: undefined,
      temperature: undefined,
    });

    const request = createMock.mock.calls[0][0];
    expect(request.response_format.image_size).toBe("1K");
    expect(request.generation_config).toEqual({ temperature: 1 });
  });
});

describe("editImage request shape", () => {
  it("sends input images in order, then the prompt, with the same image options", async () => {
    createMock.mockResolvedValue({ output_image: { data: IMG_A } });

    await editImage(
      "make it blue",
      [
        { data: IMG_A, mimeType: "image/png" },
        { data: IMG_B, mimeType: "image/webp" },
      ],
      baseConfig
    );

    expect(createMock.mock.calls[0][0]).toEqual({
      model: "gemini-3.1-flash-image",
      input: [
        { type: "image", mime_type: "image/png", data: IMG_A },
        { type: "image", mime_type: "image/webp", data: IMG_B },
        { type: "text", text: "make it blue" },
      ],
      response_format: {
        type: "image",
        image_size: "1K",
        mime_type: "image/jpeg",
        aspect_ratio: "16:9",
      },
      generation_config: { temperature: 0.7 },
    });
  });
});

describe("API error mapping", () => {
  /**
   * The SDK throws an internal Stainless-style hierarchy `@google/genai` does
   * not export, so the mapping duck-types. These shapes were captured from live
   * failing calls; `error` is the parsed body and `body` the raw one.
   */
  function apiError(args: {
    message: string;
    // Deliberately wider than the live shape: the class carrying it is internal
    // to the SDK, so a bump could re-type it and the mapping must cope.
    status?: number | string;
    error?: unknown;
    body?: string;
  }): Error {
    return Object.assign(new Error(args.message), {
      status: args.status,
      error: args.error,
      body: args.body,
    });
  }

  const googleBody = (message: string, code: number) => ({
    httpMeta: {},
    error: { message, code },
  });

  const cases: Array<[string, Error, ErrorType, string]> = [
    [
      "an unknown model (404)",
      apiError({
        message: "404 Model 'gemini-does-not-exist' not found. Did you mean one of ...",
        status: 404,
        error: googleBody("Model 'gemini-does-not-exist' not found. Did you mean one of ...", 404),
      }),
      ErrorType.API_ERROR,
      "Error: Gemini reports model 'gemini-3.1-flash-image' was not found (Model 'gemini-does-not-exist' not found. Did you mean one of ...). The model ID may have been retired, or this resolution is not offered for it; try another Gemini model or an OpenAI model.",
    ],
    [
      "an unsupported aspect_ratio value (400)",
      apiError({
        message: "400 The value '7:5' is not supported for 'response_format.aspect_ratio'.",
        status: 400,
        error: googleBody(
          "The value '7:5' is not supported for 'response_format.aspect_ratio'. Supported values: ...",
          400
        ),
      }),
      ErrorType.API_ERROR,
      "Error: Gemini rejected the request (400): The value '7:5' is not supported for 'response_format.aspect_ratio'. Supported values: .... Adjust the arguments accordingly.",
    ],
    [
      "a resolution the model does not offer (404, not a retired ID)",
      apiError({
        message: "404 Requested entity was not found.",
        status: 404,
        error: googleBody("Requested entity was not found.", 404),
      }),
      ErrorType.API_ERROR,
      "Error: Gemini reports model 'gemini-3.1-flash-image' was not found (Requested entity was not found.). The model ID may have been retired, or this resolution is not offered for it; try another Gemini model or an OpenAI model.",
    ],
    [
      "an invalid API key, whose message is only in the array-shaped body (400)",
      apiError({
        message: '400 API error occurred: [{"error":{"code":400,...}}]',
        status: 400,
        // Live shape: `error` carries no message at all, and the raw body is a
        // JSON array. Reading only `error` would lose the reason entirely.
        error: { httpMeta: {} },
        body: '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]',
      }),
      ErrorType.MISSING_API_KEY,
      "Error: Gemini rejected the API key: API key not valid. Please pass a valid API key.. Check GEMINI_API_KEY (or GOOGLE_API_KEY), or choose an OpenAI model.",
    ],
    [
      "an invalid API key behind a body that is not JSON at all (400)",
      apiError({
        message: "400 API error occurred",
        status: 400,
        error: { httpMeta: {} },
        // A gateway can answer with HTML. Nothing parses, so the reason only
        // survives because the key check reads the raw body too.
        body: "<html><body>API key not valid</body></html>",
      }),
      ErrorType.MISSING_API_KEY,
      "Error: Gemini rejected the API key: API error occurred. Check GEMINI_API_KEY (or GOOGLE_API_KEY), or choose an OpenAI model.",
    ],
    [
      "a rejected key whose status the SDK exposes as a string, not a number",
      apiError({
        message: '400 API error occurred: [{"error":{"code":400,...}}]',
        // An SDK bump could re-type this. Reading it as "no status" would call
        // an unrecoverable key rejection a network blip and advise a retry.
        status: "400",
        error: { httpMeta: {} },
        body: '[{"error":{"message":"API key not valid. Please pass a valid API key."}}]',
      }),
      ErrorType.MISSING_API_KEY,
      "Error: Gemini rejected the API key: API key not valid. Please pass a valid API key.. Check GEMINI_API_KEY (or GOOGLE_API_KEY), or choose an OpenAI model.",
    ],
    [
      "a rate limit whose status survives only in the SDK's message prefix",
      apiError({
        message: "429 Resource has been exhausted (e.g. check quota).",
        status: undefined,
        error: { error: { message: "Resource has been exhausted (e.g. check quota)." } },
      }),
      ErrorType.API_RATE_LIMIT,
      "Error: Gemini rate limit exceeded (429): Resource has been exhausted (e.g. check quota).. Wait a minute and retry, lower num_images, or use an OpenAI model.",
    ],
    [
      "a safety block (400)",
      apiError({
        message: "400 The request was blocked by safety filters.",
        status: 400,
        error: googleBody("The request was blocked by safety filters.", 400),
      }),
      ErrorType.CONTENT_BLOCKED,
      "Error: Gemini's safety filters blocked this request: The request was blocked by safety filters.. Rephrase the prompt or change the input images.",
    ],
    [
      "a permission denial (403)",
      apiError({
        message: "403 Permission denied on resource project.",
        status: 403,
        error: googleBody("Permission denied on resource project.", 403),
      }),
      ErrorType.MISSING_API_KEY,
      "Error: Gemini denied the request (403): Permission denied on resource project.. Check GEMINI_API_KEY (or GOOGLE_API_KEY) and the project's billing, or choose an OpenAI model.",
    ],
    [
      "a rate limit (429)",
      apiError({
        message: "429 Resource has been exhausted (e.g. check quota).",
        status: 429,
        error: googleBody("Resource has been exhausted (e.g. check quota).", 429),
      }),
      ErrorType.API_RATE_LIMIT,
      "Error: Gemini rate limit exceeded (429): Resource has been exhausted (e.g. check quota).. Wait a minute and retry, lower num_images, or use an OpenAI model.",
    ],
    [
      "a server fault whose body is not JSON, leaving only the SDK's message (503)",
      apiError({
        message: "503 Service Unavailable",
        status: 503,
        // A gateway page rather than Google's JSON: the message can only come
        // from the SDK, whose own "503 " prefix our text would otherwise repeat.
        body: "<html><body>503 Service Unavailable</body></html>",
      }),
      ErrorType.API_ERROR,
      "Error: Gemini request failed (503): Service Unavailable. Retry; if it persists, try an OpenAI model.",
    ],
    [
      "a connection failure, which carries no status, error or body",
      apiError({ message: "Unable to make request: TypeError: fetch failed" }),
      ErrorType.API_ERROR,
      "Error: Gemini request failed (network): Unable to make request: TypeError: fetch failed. Retry; if it persists, try an OpenAI model.",
    ],
  ];

  for (const [name, error, type, message] of cases) {
    it(`maps ${name} to ${type}`, async () => {
      createMock.mockRejectedValue(error);
      await expect(generateImage("p", baseConfig)).rejects.toMatchObject({ type, message });
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
    const mod = await import("../gemini.js");
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

  it("names the variable to set, and the alternative, when neither key is present", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const { generateImage } = await freshGenerate();
    // vi.resetModules() gives this module graph its own McpError class, so
    // match on the shape rather than instanceof.
    await expect(generateImage("p", baseConfig)).rejects.toMatchObject({
      type: ErrorType.MISSING_API_KEY,
      message: expect.stringMatching(
        /GEMINI_API_KEY is not set.*choose an OpenAI model/s
      ),
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});
