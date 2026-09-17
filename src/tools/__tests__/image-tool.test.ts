/**
 * The pipeline in `tools/image-tool.ts` — the num_images loop, saving, usage,
 * the warning and the failure result — is shared by both tools, so it is
 * tested once, through hokuz_generate_image (the tool with the simpler
 * mapping). `generate-image.test.ts` and `edit-image.test.ts` then cover only
 * what is their own: the param -> GenerationConfig mapping, image loading, and
 * validation order.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ErrorType, McpError } from "../../types.js";

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/index.js")>();
  return { ...actual, generateImage: generateMock };
});

const { connectTestClient, firstText } = await import("../../__tests__/harness.js");

const TOOL = "hokuz_generate_image";
const IMG = Buffer.from("fake-jpeg-bytes").toString("base64");
const okResponse = (description?: string) => ({
  images: [{ data: IMG, mimeType: "image/jpeg" }],
  description,
});

let tmp: string;
let harness: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  generateMock.mockReset();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-pipeline-"));
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("image tool pipeline", () => {
  it("makes one request per requested image and suffixes the filenames", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: path.join(tmp, "v.jpg"),
      num_images: 3,
    });

    expect(generateMock).toHaveBeenCalledTimes(3);
    const paths = (result.structuredContent as { images: Array<{ path: string }> }).images.map(
      (i) => i.path
    );
    expect(paths).toEqual([
      path.join(tmp, "v.jpg"),
      path.join(tmp, "v-2.jpg"),
      path.join(tmp, "v-3.jpg"),
    ]);
    for (const p of paths) await fs.access(p);
  });

  it("saves only the requested count when a single response carries extra images", async () => {
    generateMock.mockResolvedValue({
      images: [
        { data: IMG, mimeType: "image/jpeg" },
        { data: Buffer.from("second").toString("base64"), mimeType: "image/jpeg" },
      ],
    });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: path.join(tmp, "one.jpg"),
    });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(1);
    expect(await fs.readdir(tmp)).toEqual(["one.jpg"]);
  });

  it("keeps what it has and warns when a later request fails", async () => {
    generateMock
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new McpError(ErrorType.API_RATE_LIMIT, "Error: Rate limit exceeded."));

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      num_images: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({ success: true });
    expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      warning:
        "Requested 3 image(s) but only 1 were produced. The failed request reported: Error: Rate limit exceeded.",
    });
    expect(firstText(result)).toContain(
      "Warning: Requested 3 image(s) but only 1 were produced. The failed request reported: Error: Rate limit exceeded."
    );
  });

  it("surfaces the error when the first request fails", async () => {
    generateMock.mockRejectedValue(
      new McpError(
        ErrorType.CONTENT_BLOCKED,
        "Error: No images were generated. The content may have been blocked by safety filters. Try modifying your prompt."
      )
    );

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("blocked by safety filters");
    expect(result.structuredContent).toEqual({
      success: false,
      images: [],
      error:
        "Error: No images were generated. The content may have been blocked by safety filters. Try modifying your prompt.",
      // The McpError's own type, so the caller can act without parsing prose.
      error_type: "CONTENT_BLOCKED",
      // Nothing about repeating this call would change the verdict.
      retryable: false,
    });
  });

  it("wraps a non-McpError in the tool's own 'Unexpected error' message", async () => {
    // Every provider failure is an McpError whose message passes through as
    // is; this is the one branch that composes a message. Edit's activity
    // word is pinned in edit-image.test.ts.
    generateMock.mockRejectedValue(new Error("boom"));

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("Error: Unexpected error during image generation. boom");
    expect(result.structuredContent).toEqual({
      success: false,
      images: [],
      error: "Error: Unexpected error during image generation. boom",
      error_type: "UNKNOWN_ERROR",
      // We have no idea what went wrong, so we do not invite a retry.
      retryable: false,
    });
  });

  it("lets a provider's own verdict override the type's default", async () => {
    // API_ERROR is retryable by type, so a 4xx the mapper marked unretryable
    // would otherwise be published as "try again" and be rejected again.
    generateMock.mockRejectedValue(
      new McpError(
        ErrorType.API_ERROR,
        "Error: OpenAI rejected the request: Invalid value. Adjust the arguments accordingly.",
        undefined,
        { retryable: false }
      )
    );

    const rejected = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });
    expect(rejected.structuredContent).toMatchObject({
      error_type: "API_ERROR",
      retryable: false,
    });

    // The table's other true: a rate limit clears on its own, and the schema
    // tells the caller to wait and retry, so the verdict must agree.
    generateMock.mockRejectedValue(
      new McpError(ErrorType.API_RATE_LIMIT, "Error: Rate limit exceeded.")
    );
    const rateLimited = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });
    expect(rateLimited.structuredContent).toMatchObject({
      error_type: "API_RATE_LIMIT",
      retryable: true,
    });

    // Without a verdict from the mapper the table answers, and for API_ERROR
    // (a 5xx or a dropped connection) its answer is "retry".
    generateMock.mockRejectedValue(
      new McpError(ErrorType.API_ERROR, "Error: Gemini request failed (network): fetch failed.")
    );

    const transient = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });
    expect(transient.structuredContent).toMatchObject({
      error_type: "API_ERROR",
      retryable: true,
    });
  });

  it("reports the provider's pixel size and sums usage across the num_images loop", async () => {
    generateMock.mockResolvedValue({
      images: [{ data: IMG, mimeType: "image/jpeg", width: 1360, height: 768 }],
      usage: {
        inputTokens: 15,
        outputTokens: 229,
        estimatedCostUsd: 0.007,
        costBasis: "tokens",
      },
    });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      aspect_ratio: "16:9",
      num_images: 2,
    });

    expect(result.structuredContent).toMatchObject({
      usage: {
        input_tokens: 30,
        output_tokens: 458,
        estimated_cost_usd: 0.014,
        cost_basis: "tokens",
        requests_succeeded: 2,
        requests_reported: 2,
      },
    });
    const images = (result.structuredContent as {
      images: Array<{ width?: number; height?: number }>;
    }).images;
    expect(images.map((i) => [i.width, i.height])).toEqual([
      [1360, 768],
      [1360, 768],
    ]);
    expect(firstText(result)).toContain("(1360x768)");
    expect(firstText(result)).toContain(
      "Usage: 30 input + 458 output tokens, estimated cost $0.0140 (from those token counts)"
    );
  });

  it("says how many requests the usage totals cover when it is not all of them", async () => {
    generateMock
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: {
          inputTokens: 15,
          outputTokens: 229,
          estimatedCostUsd: 0.007,
          costBasis: "tokens",
        },
      })
      .mockResolvedValueOnce(okResponse());

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      model: "gpt-image-2.5-flare",
      num_images: 2,
    });

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(firstText(result)).toContain(
      "Usage (reported for 1 of 2 requests): 15 input + 229 output tokens, estimated cost $0.0070 (from those token counts)"
    );
    // The same scope in the structured channel: a caller reading only that one
    // must not take the totals for the whole call's cost.
    expect(result.structuredContent).toMatchObject({
      usage: { requests_succeeded: 2, requests_reported: 1 },
    });
  });

  it("sums the counts of the requests that reported them, ignoring those that did not", async () => {
    // Gemini prices per image, so a request can carry a cost with no counts.
    generateMock
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: {
          inputTokens: 9,
          outputTokens: 1481,
          estimatedCostUsd: 0.0625,
          costBasis: "per_image",
        },
      })
      .mockResolvedValueOnce({
        images: [{ data: IMG, mimeType: "image/jpeg" }],
        usage: { estimatedCostUsd: 0.0625, costBasis: "per_image" },
      });

    const result = await harness.callTool(TOOL, {
      prompt: "p",
      output_path: tmp,
      num_images: 2,
    });

    expect(result.structuredContent).toMatchObject({
      usage: {
        input_tokens: 9,
        output_tokens: 1481,
        estimated_cost_usd: 0.125,
        cost_basis: "per_image",
        // Both requests priced their image, so the totals cover the whole call.
        requests_succeeded: 2,
        requests_reported: 2,
      },
    });
    expect(firstText(result)).toContain(
      "Usage: 9 input + 1481 output tokens, estimated cost $0.1250 (the provider's per-image price, not derived from those tokens)"
    );
  });

  it("omits a token count entirely rather than reporting 0 when no request gave one", async () => {
    // A 0 would assert the provider charged nothing for input, which is a
    // different claim from "the provider did not say". Both channels stay quiet.
    generateMock.mockResolvedValue({
      images: [{ data: IMG, mimeType: "image/jpeg" }],
      usage: { estimatedCostUsd: 0.067, costBasis: "per_image" },
    });

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    const usage = (result.structuredContent as { usage: Record<string, unknown> }).usage;
    expect(usage).toEqual({
      estimated_cost_usd: 0.067,
      cost_basis: "per_image",
      requests_succeeded: 1,
      requests_reported: 1,
    });
    expect(firstText(result)).toContain(
      "Usage: estimated cost $0.0670 (the provider's per-image price, not derived from those tokens)"
    );
    // No count is named. The basis clause still says "tokens" to deny them, so
    // match the shape a count would take rather than the bare word.
    expect(firstText(result)).not.toMatch(/\d+ input/);
    expect(firstText(result)).not.toMatch(/\d+ output/);
  });

  it("omits usage and dimensions for a provider that reports neither", async () => {
    generateMock.mockResolvedValue(okResponse());

    const result = await harness.callTool(TOOL, { prompt: "p", output_path: tmp });

    // toEqual treats an undefined-valued key as absent, which is what a JSON
    // transport delivers; the point is that neither field carries a value.
    expect(result.structuredContent).toEqual({
      success: true,
      images: [{ path: expect.any(String), format: "jpeg" }],
    });
    expect(firstText(result)).not.toContain("Usage:");
    expect(firstText(result)).toContain("Successfully generated 1 image(s)");
  });
});
