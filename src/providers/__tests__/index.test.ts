import { describe, it, expect, beforeEach, vi } from "vitest";
import { ErrorType, type GenerationConfig } from "../../types.js";

const { geminiGenerate, geminiEdit, openaiGenerate, openaiEdit } = vi.hoisted(() => ({
  geminiGenerate: vi.fn(),
  geminiEdit: vi.fn(),
  openaiGenerate: vi.fn(),
  openaiEdit: vi.fn(),
}));

vi.mock("../gemini.js", () => ({
  generateImage: geminiGenerate,
  editImage: geminiEdit,
}));
vi.mock("../openai.js", () => ({
  generateImage: openaiGenerate,
  editImage: openaiEdit,
}));

const { generateImage, editImage, enabledProviders } = await import("../index.js");

const response = { images: [{ data: "AAA", mimeType: "image/jpeg" }] };

const geminiConfig: GenerationConfig = {
  model: "gemini-3.1-flash-image",
  aspectRatio: "1:1",
  resolution: "1K",
  outputFormat: "jpeg",
  temperature: 1.0,
};

const openaiConfig: GenerationConfig = {
  model: "gpt-image-2.5-flare",
  aspectRatio: "1:1",
  resolution: "1K",
  outputFormat: "jpeg",
  quality: "medium",
};

beforeEach(() => {
  for (const mock of [geminiGenerate, geminiEdit, openaiGenerate, openaiEdit]) {
    mock.mockReset();
    mock.mockResolvedValue(response);
  }
});

describe("dispatch", () => {
  it("sends a Gemini model to the Gemini provider and nowhere else", async () => {
    await generateImage("p", geminiConfig);
    expect(geminiGenerate).toHaveBeenCalledWith("p", geminiConfig);
    expect(openaiGenerate).not.toHaveBeenCalled();
  });

  it("sends an OpenAI model to the OpenAI provider and nowhere else", async () => {
    await generateImage("p", openaiConfig);
    expect(openaiGenerate).toHaveBeenCalledWith("p", openaiConfig);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("routes edits by the same registry entry, passing the input images through", async () => {
    const images = [{ data: "BBB", mimeType: "image/png" }];

    await editImage("p", images, openaiConfig);
    expect(openaiEdit).toHaveBeenCalledWith("p", images, openaiConfig);
    expect(geminiEdit).not.toHaveBeenCalled();

    await editImage("p", images, geminiConfig);
    expect(geminiEdit).toHaveBeenCalledWith("p", images, geminiConfig);
  });
});

describe("validation before dispatch", () => {
  it("rejects an unsupported resolution without calling any provider", async () => {
    await expect(
      generateImage("p", { ...geminiConfig, model: "gemini-3.1-flash-lite-image", resolution: "2K" })
    ).rejects.toThrowError(
      expect.objectContaining({ type: ErrorType.INVALID_MODEL_OPTION })
    );
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("rejects 'quality' on a Gemini model and names the OpenAI alternative", async () => {
    await expect(
      editImage("p", [], { ...geminiConfig, quality: "high" })
    ).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_MODEL_OPTION,
        message:
          "Error: Model 'gemini-3.1-flash-image' (Nano Banana 2) does not accept 'quality'; it is an OpenAI-only option. Omit it, or use gpt-image-2.5-flare / gpt-image-2.5-sunburst.",
      })
    );
    expect(geminiEdit).not.toHaveBeenCalled();
  });

  it("rejects 'temperature' on an OpenAI model and names the Gemini alternative", async () => {
    await expect(
      generateImage("p", { ...openaiConfig, temperature: 0.2 })
    ).rejects.toThrowError(
      expect.objectContaining({
        type: ErrorType.INVALID_MODEL_OPTION,
        message:
          "Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not accept 'temperature'; it is a Gemini-only option. Omit it, or use a gemini-* model.",
      })
    );
    expect(openaiGenerate).not.toHaveBeenCalled();
  });
});

describe("enabledProviders", () => {
  it("lists only the providers whose key is present", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "k");
    expect(enabledProviders()).toEqual(["openai"]);

    vi.stubEnv("GOOGLE_API_KEY", "k");
    expect(enabledProviders()).toEqual(["google", "openai"]);

    vi.stubEnv("OPENAI_API_KEY", "");
    expect(enabledProviders()).toEqual(["google"]);

    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(enabledProviders()).toEqual([]);
  });
});
