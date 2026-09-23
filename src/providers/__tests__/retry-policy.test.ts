import { afterEach, expect, it, vi } from "vitest";
import type { GenerationConfig } from "../../types.js";

// Exercise the installed SDKs with a fake HTTP transport, never a live provider.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each(["openai", "gemini"] as const)("%s sends only one HTTP attempt per generation or edit", async (provider) => {
  vi.resetModules();
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  vi.stubEnv("GEMINI_API_KEY", "test-only");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: { message: "Unavailable", code: 503 } }), {
    status: 503, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    // OpenAI probes native FormData support with a data URL before an upload.
    if (input === "data:,") return Promise.resolve(new Response(""));
    return fetch(input, init);
  });
  const api = provider === "openai" ? await import("../openai.js") : await import("../gemini.js");
  const config: GenerationConfig = {
    model: provider === "openai" ? "gpt-image-2.5-flare" : "gemini-3.1-flash-image",
    aspectRatio: "1:1", resolution: "1K", outputFormat: "jpeg",
  };
  await expect(api.generateImage("p", config)).rejects.toMatchObject({ issue: { code: "API_ERROR" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  await expect(api.editImage("p", [{ data: "YQ==", mimeType: "image/jpeg" }], config)).rejects.toMatchObject({ issue: { code: "API_ERROR" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
