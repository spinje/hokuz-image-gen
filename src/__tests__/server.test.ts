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
  it("reports the package.json name and version to clients", async () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      name: string;
      version: string;
    };
    expect(harness.client.getServerVersion()).toEqual({ name: pkg.name, version: pkg.version });
  });

  it("registers exactly the two nanobanana_ tools with non-destructive, open-world annotations", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "nanobanana_edit_image",
      "nanobanana_generate_image",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.outputSchema).toBeDefined();
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
    const generate = tools.find((t) => t.name === "nanobanana_generate_image")!;
    const props = generate.inputSchema.properties as Record<
      string,
      { enum?: string[]; default?: unknown }
    >;
    expect(props.model.enum).toEqual([
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "gemini-3-pro-image",
    ]);
    expect(props.model.default).toBe("gemini-3.1-flash-image");
    expect(props.aspect_ratio.default).toBe("1:1");
    expect(props.resolution.default).toBe("1K");
    expect(props.num_images.default).toBe(1);
    expect(props.output_format.enum).toEqual(["jpeg"]);
    expect(generate.inputSchema.required).toEqual(["prompt", "output_path"]);

    const edit = tools.find((t) => t.name === "nanobanana_edit_image")!;
    const editProps = edit.inputSchema.properties as Record<string, { default?: unknown }>;
    expect(editProps.aspect_ratio.default).toBe("auto");
    expect(edit.inputSchema.required).toEqual(["prompt", "image_paths", "output_path"]);
  });
});
