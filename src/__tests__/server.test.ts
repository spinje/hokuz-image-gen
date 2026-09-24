import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { IMAGE_MODELS, IMAGE_MODEL_CAPABILITIES, QUALITIES, type ImageModel } from "../constants.js";
import { expectedSize } from "../providers/index.js";
import { ErrorType } from "../types.js";
import { connectTestClient } from "./harness.js";

/**
 * Claude Code truncates (verified in 2.1.281, whose changelog added an override) each MCP tool description and the
 * server instructions at 2,048 characters; the rest never reaches the model.
 * Field describe strings are delivered in full, so field rules belong there.
 */
const CLAUDE_CODE_TEXT_CAP = 2048;

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
        "aspect_error_pct",
        "format",
        "height",
        "path",
        "preview",
        "preview_warning",
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
        "requests_completed",
        "requests_reported",
      ]);
      expect(usage.required.sort()).toEqual([
        "cost_basis",
        "estimated_cost_usd",
        "requests_completed",
        "requests_reported",
      ]);
      // settings is what a caller cites as "made with": only the options that
      // apply to every model are required; the provider-only ones and the
      // resolution an OpenAI auto edit leaves to the provider are optional.
      const settings = outputProperties.settings as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(settings.properties).sort()).toEqual([
        "aspect_ratio",
        "expected_size",
        "model",
        "output_format",
        "quality",
        "resolution",
        "temperature",
        "transparent_background",
      ]);
      expect(settings.required.sort()).toEqual(["aspect_ratio", "model", "output_format"]);
      expect(outputProperties.status).toMatchObject({ enum: ["complete", "partial", "failed"] });
      const issue = outputProperties.issue as { properties: Record<string, unknown>; required: string[] };
      expect(issue.required.sort()).toEqual(["code", "message", "next_step"]);
      expect(issue.properties.code).toMatchObject({ enum: Object.values(ErrorType) });
      for (const legacy of ["success", "warning", "error", "error_type", "retryable"]) {
        expect(outputProperties).not.toHaveProperty(legacy);
      }
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
      // Output formats decide the model for png/webp/transparent deliverables,
      // so they sit beside the model choice, not only in output_format.
      expect(tool.description).toContain("Gemini outputs jpeg only");
      expect(tool.description).toMatch(/OpenAI outputs jpeg, png or webp, including transparent/);
    }
  });

  it("lists in both aspect_ratio fields the 1K sizes a result reports as expected_size", async () => {
    // What a caller reads before paying must be what settings.expected_size
    // says afterwards: one list per provider, built from the same function.
    const listFor = (model: ImageModel) => IMAGE_MODEL_CAPABILITIES[model].aspectRatios
      .map((aspectRatio) => `${aspectRatio} ${expectedSize({ model, aspectRatio, resolution: "1K", outputFormat: "jpeg" })}`)
      .join(", ");
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      const aspect = (tool.inputSchema.properties as Record<string, { description?: string }>).aspect_ratio.description;
      expect(aspect).toContain(`Gemini (measured on Flash for every ratio; Pro and Lite matched in spot checks): ${listFor("gemini-3.1-flash-image")}.`);
      expect(aspect).toContain(`OpenAI (exact; the size requested): ${listFor("gpt-image-2.5-flare")}.`);
      expect(aspect).toContain(
        `OpenAI 16:9 is ${expectedSize({ model: "gpt-image-2.5-flare", aspectRatio: "16:9", resolution: "2K", outputFormat: "jpeg" })}.`
      );
      // The two providers' grids differ, so the lists above are not one list twice.
      expect(aspect).toContain("16:9 1376x768");
      expect(aspect).toContain("16:9 1360x768");
    }
  });

  it("fits both descriptions and the server instructions within Claude Code's cap", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.description!.length).toBeLessThanOrEqual(CLAUDE_CODE_TEXT_CAP);
    }
    // Shown before any tool schema is loaded: the URL guidance must be in it.
    const instructions = harness.client.getInstructions();
    expect(instructions).toContain("image_paths");
    expect(instructions).toContain("HTTP(S)");
    expect(instructions).toContain("do not download");
    expect(instructions!.length).toBeLessThanOrEqual(CLAUDE_CODE_TEXT_CAP);
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
    expect(props.include_preview).toMatchObject({ type: "boolean", default: false });
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
    expect(editProps.include_preview).toMatchObject({ type: "boolean", default: false });
    // Edit's resolution is optional with no default (gotcha 7): "auto" plus an
    // explicit resolution is rejected, which a filled-in default would hide.
    expect(editProps.resolution).not.toHaveProperty("default");
    // The schema bound is the largest any model accepts; the per-model limit
    // (Gemini 14) is enforced by the registry before any image is loaded.
    expect(editProps.image_paths.maxItems).toBe(16);
    expect(edit.inputSchema.required).toEqual(["prompt", "image_paths", "output_path"]);
  });
});
