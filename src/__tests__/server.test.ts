import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectTestClient } from "./harness.js";

let harness: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  harness = await connectTestClient();
});

afterEach(async () => {
  await harness.close();
});

describe("server", () => {
  it("registers exactly the two nanobanana_ tools", async () => {
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["nanobanana_edit_image", "nanobanana_generate_image"]);
    for (const tool of tools) {
      expect(tool.name.startsWith("nanobanana_")).toBe(true);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("advertises annotations that describe a non-destructive external call", async () => {
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it("exposes the model enum and defaults in the published input schema", async () => {
    const { tools } = await harness.client.listTools();
    const generate = tools.find((t) => t.name === "nanobanana_generate_image")!;
    const props = generate.inputSchema.properties as Record<string, { enum?: string[]; default?: unknown }>;
    expect(props.model.enum).toEqual([
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "gemini-3-pro-image",
    ]);
    expect(props.model.default).toBe("gemini-3.1-flash-image");
    expect(props.output_format.enum).toEqual(["jpeg"]);
    expect(generate.inputSchema.required).toEqual(["prompt", "output_path"]);
  });
});
