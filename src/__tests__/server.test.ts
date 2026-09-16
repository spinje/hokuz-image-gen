import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { IMAGE_MODELS, QUALITIES } from "../constants.js";
import { ErrorType } from "../types.js";
import { connectTestClient } from "./harness.js";

let harness: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
});

describe("published tool contract", () => {
  it("reports the server name and version from package.json to clients", async () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      name: string;
      version: string;
    };
    expect(harness.client.getServerVersion()).toEqual({ name: pkg.name, version: pkg.version });
  });

  it("registers exactly the two hokuz_ tools with non-destructive, open-world annotations", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hokuz_edit_image",
      "hokuz_generate_image",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      // Output items are always saved files: path and format, nothing optional.
      const outputProperties = (
        tool.outputSchema as unknown as {
          properties: Record<string, unknown> & {
            images: { items: { required: string[]; properties: Record<string, unknown> } };
          };
        }
      ).properties;
      const items = outputProperties.images.items;
      expect(items.required.sort()).toEqual(["format", "path"]);
      expect(items.properties).not.toHaveProperty("dataUrl");
      // Pixel size stays optional: a JPEG header we cannot walk yields none.
      expect(Object.keys(items.properties).sort()).toEqual([
        "format",
        "height",
        "path",
        "width",
      ]);
      // usage is what a caller quotes back as "this cost $X", so its shape is
      // the claim: the counts are optional because a provider can price a
      // request without reporting them, cost_basis says whether they produced
      // the cost at all, and the two request counts say what the totals cover.
      const usage = outputProperties.usage as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(Object.keys(usage.properties).sort()).toEqual([
        "cost_basis",
        "estimated_cost_usd",
        "input_tokens",
        "output_tokens",
        "requests_reported",
        "requests_succeeded",
      ]);
      expect(usage.required.sort()).toEqual([
        "cost_basis",
        "estimated_cost_usd",
        "requests_reported",
        "requests_succeeded",
      ]);
      expect(outputProperties).toHaveProperty("warning");
      // error_type is how the caller picks its next step, so the published
      // list must be every type the pipeline can actually emit.
      expect((outputProperties.error_type as { enum: string[] }).enum).toEqual(
        Object.values(ErrorType)
      );
      // The enum is what the caller matches on; the describe string is what
      // tells it what to do about each value. A tenth type would otherwise be
      // published with no guidance at all.
      const errorTypeGuidance = (outputProperties.error_type as { description: string })
        .description;
      for (const type of Object.values(ErrorType)) {
        expect(errorTypeGuidance).toContain(type);
      }
      // retryable answers what error_type cannot: whether the same call again
      // could work. No default — it is absent on a success, not "false".
      expect(outputProperties.retryable).toMatchObject({ type: "boolean" });
      expect(outputProperties.retryable).not.toHaveProperty("default");
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it("names every model and every quality level in both descriptions the LLM reads", async () => {
    // The tool description, the model describe string, the README and this file
    // are hand-maintained and drift apart silently. This is the mechanical half
    // of keeping them in sync: a model or quality added to the registry without
    // a word about it in the text the caller reads fails here.
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(2);

    for (const tool of tools) {
      const modelDescription = (
        tool.inputSchema.properties as Record<string, { description?: string }>
      ).model.description;

      for (const model of IMAGE_MODELS) {
        expect(tool.description).toContain(model);
        expect(modelDescription).toContain(model);
      }
      for (const quality of QUALITIES) {
        // Word boundaries: "low" is a substring of "follow", "high" of "xhigh".
        expect(tool.description).toMatch(new RegExp(`\\b${quality}\\b`));
      }
    }
  });

  it("publishes optional params with enums and defaults, and only prompt/output_path as required", async () => {
    // The calling LLM sees this JSON Schema, not the Zod source. A regression
    // in Zod -> JSON Schema conversion (e.g. after a Zod major bump) that drops
    // defaults or marks defaulted fields required would silently change how
    // models call the tool.
    const { tools } = await harness.client.listTools();
    const generate = tools.find((t) => t.name === "hokuz_generate_image")!;
    const props = generate.inputSchema.properties as Record<
      string,
      { enum?: string[]; default?: unknown; type?: string }
    >;
    expect(props.model.enum).toEqual([
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "gemini-3-pro-image",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
    ]);
    expect(props.model.default).toBe("gemini-3.1-flash-image");
    expect(props.aspect_ratio.default).toBe("1:1");
    expect(props.resolution.default).toBe("1K");
    expect(props.num_images.default).toBe(1);
    expect(props.output_format.enum).toEqual(["jpeg", "png", "webp"]);
    // No default: without one the handler can tell an explicit format from a
    // filled-in default and fall back to the output_path's extension.
    expect(props.output_format).not.toHaveProperty("default");
    expect(generate.inputSchema.required).toEqual(["prompt", "output_path"]);

    // Provider-specific options: published with their enum but no default, so
    // the handler can tell "the LLM asked for this" from "the SDK filled it in".
    expect(props.quality.enum).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(props.quality).not.toHaveProperty("default");
    expect(props.temperature).not.toHaveProperty("default");
    expect(props.transparent_background.type).toBe("boolean");
    expect(props.transparent_background).not.toHaveProperty("default");

    const edit = tools.find((t) => t.name === "hokuz_edit_image")!;
    const editProps = edit.inputSchema.properties as Record<
      string,
      { default?: unknown; maxItems?: number }
    >;
    expect(editProps.aspect_ratio.default).toBe("auto");
    // Edit's resolution is optional with no default (gotcha 7): "auto" plus an
    // explicit resolution is rejected, which a filled-in default would hide.
    expect(editProps.resolution).not.toHaveProperty("default");
    // The schema bound is the largest any model accepts; the per-model limit
    // (Gemini 14) is enforced by the registry before any image is loaded.
    expect(editProps.image_paths.maxItems).toBe(16);
    expect(edit.inputSchema.required).toEqual(["prompt", "image_paths", "output_path"]);
  });
});
