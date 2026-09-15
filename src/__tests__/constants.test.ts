import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  IMAGE_MODELS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedModelOptionMessage,
  type Quality,
} from "../constants.js";

describe("getUnsupportedModelOptionMessage", () => {
  it("rejects a resolution the model does not support and names the supported ones", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3.1-flash-lite-image",
      resolution: "2K",
      aspectRatio: "1:1",
    });
    expect(message).toMatch(/does not support resolution '2K'/);
    expect(message).toMatch(/Supported resolutions: 1K\./);
    expect(message).toMatch(/or a model that supports '2K'\.$/);
  });

  it("rejects a resolution outside the OpenAI 1K/2K band", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gpt-image-2.5-flare",
      resolution: "4K",
      aspectRatio: "1:1",
    });
    expect(message).toMatch(/does not support resolution '4K'/);
    expect(message).toMatch(/Supported resolutions: 1K, 2K\./);
  });

  it("rejects an extreme aspect ratio on a model without it", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3-pro-image",
      resolution: "1K",
      aspectRatio: "1:4",
    });
    expect(message).toMatch(/does not support aspect ratio '1:4'/);
    expect(message).toMatch(/or a model that supports '1:4'\.$/);
  });

  it("skips the aspect ratio check when none is given (edit 'auto')", () => {
    // Pro does not support the extreme ratios; with no ratio at all it must still pass.
    expect(
      getUnsupportedModelOptionMessage({ model: "gemini-3-pro-image", resolution: "1K" })
    ).toBeNull();
  });

  it("rejects an explicit resolution with edit 'auto' on OpenAI, which derives size from the ratio", () => {
    expect(
      getUnsupportedModelOptionMessage({ model: "gpt-image-2.5-flare", resolution: "2K" })
    ).toBe(
      "Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) cannot apply resolution '2K' when aspect_ratio is 'auto' because the provider chooses the output size. Set an aspect_ratio to control the size, or omit resolution."
    );
    // Gemini applies the resolution whatever the ratio, so the same call is fine there.
    expect(
      getUnsupportedModelOptionMessage({ model: "gemini-3.1-flash-image", resolution: "2K" })
    ).toBeNull();
  });

  it("rejects a quality outside the model's ladder, naming the supported ones", () => {
    // The enum keeps this out of a real call; the check must still test the
    // list rather than "does this model have any qualities at all".
    expect(
      getUnsupportedModelOptionMessage({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        quality: "ultra" as unknown as Quality,
      })
    ).toBe(
      "Error: Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not support quality 'ultra'. Supported qualities: low, medium, high, xhigh, max."
    );
  });

  it("rejects 'quality' on a model that has no quality ladder, naming the alternative", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        quality: "high",
      })
    ).toBe(
      "Error: Model 'gemini-3.1-flash-image' (Nano Banana 2) does not accept 'quality'; it is an OpenAI-only option. Omit it, or use gpt-image-2.5-flare / gpt-image-2.5-sunburst."
    );
  });

  it("rejects 'temperature' on a model that does not take one, naming the alternative", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: "gpt-image-2.5-sunburst",
        resolution: "1K",
        aspectRatio: "1:1",
        temperature: 0.2,
      })
    ).toBe(
      "Error: Model 'gpt-image-2.5-sunburst' (GPT Image 2.5 Sunburst) does not accept 'temperature'; it is a Gemini-only option. Omit it, or use a gemini-* model."
    );
  });

  it("accepts a temperature of 0, which is a real value and not an absent option", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        temperature: 0,
      })
    ).toBeNull();
    expect(
      getUnsupportedModelOptionMessage({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        temperature: 0,
      })
    ).toMatch(/does not accept 'temperature'/);
  });

  it("the shipped defaults are a valid call for every model in the registry", () => {
    // Guards against a new model, or a changed DEFAULT, whose default call the
    // server would reject. The providers apply DEFAULTS.temperature and
    // DEFAULTS.quality themselves, so those must be valid for them too.
    for (const model of IMAGE_MODELS) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      expect({
        model,
        message: getUnsupportedModelOptionMessage({
          model,
          resolution: DEFAULTS.resolution,
          aspectRatio: DEFAULTS.aspectRatio,
        }),
      }).toEqual({ model, message: null });
      expect({
        model,
        qualityOk: caps.qualities.length === 0 || caps.qualities.includes(DEFAULTS.quality),
      }).toEqual({ model, qualityOk: true });
    }
  });
});
