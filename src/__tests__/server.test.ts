import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
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
      // Pixel size is optional because only OpenAI reports it.
      expect(Object.keys(items.properties).sort()).toEqual([
        "format",
        "height",
        "path",
        "width",
      ]);
      expect(outputProperties).toHaveProperty("usage");
      expect(outputProperties).toHaveProperty("warning");
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
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
      { enum?: string[]; default?: unknown }
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
    expect(props.output_format.enum).toEqual(["jpeg"]);
    expect(generate.inputSchema.required).toEqual(["prompt", "output_path"]);

    // Provider-specific options: published with their enum but no default, so
    // the handler can tell "the LLM asked for this" from "the SDK filled it in".
    expect(props.quality.enum).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(props.quality).not.toHaveProperty("default");
    expect(props.temperature).not.toHaveProperty("default");

    const edit = tools.find((t) => t.name === "hokuz_edit_image")!;
    const editProps = edit.inputSchema.properties as Record<string, { default?: unknown }>;
    expect(editProps.aspect_ratio.default).toBe("auto");
    // Edit's resolution is optional with no default (gotcha 8): "auto" plus an
    // explicit resolution is rejected, which a filled-in default would hide.
    expect(editProps.resolution).not.toHaveProperty("default");
    expect(edit.inputSchema.required).toEqual(["prompt", "image_paths", "output_path"]);
  });
});
