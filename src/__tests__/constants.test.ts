import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  IMAGE_MODELS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedModelOptionMessage,
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
        temperature: 0,
      })
    ).toMatch(/does not accept 'temperature'/);
  });

  it("the shipped defaults are a valid call for every model in the registry", () => {
    // Guards against a new model, or a changed DEFAULT, whose default call the
    // server would reject. Mirrors the per-provider defaulting the handlers do.
    for (const model of IMAGE_MODELS) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      const resolution = caps.resolutions.includes(DEFAULTS.resolution)
        ? DEFAULTS.resolution
        : caps.resolutions[0];
      expect({
        model,
        message: getUnsupportedModelOptionMessage({
          model,
          resolution,
          aspectRatio: DEFAULTS.aspectRatio,
          temperature: caps.supportsTemperature ? DEFAULTS.temperature : undefined,
          quality: caps.qualities.length > 0 ? DEFAULTS.quality : undefined,
        }),
      }).toEqual({ model, message: null });
    }
  });

  it("the default model accepts the shipped default resolution as published", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: DEFAULTS.model,
        resolution: DEFAULTS.resolution,
        aspectRatio: DEFAULTS.aspectRatio,
      })
    ).toBeNull();
  });
});
