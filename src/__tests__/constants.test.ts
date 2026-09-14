import { describe, it, expect } from "vitest";
import {
  ASPECT_RATIOS,
  BASE_ASPECT_RATIOS,
  DEFAULTS,
  IMAGE_MODELS,
  IMAGE_MODEL_CAPABILITIES,
  IMAGE_SIZE_API_VALUES,
  RESOLUTIONS,
  getUnsupportedModelOptionMessage,
} from "../constants.js";

describe("getUnsupportedModelOptionMessage", () => {
  it("rejects a resolution the model does not support", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3.1-flash-lite-image",
      resolution: "2K",
      aspectRatio: "1:1",
    });
    expect(message).toMatch(/does not support resolution '2K'/);
    expect(message).toMatch(/Supported resolutions: 1K/);
  });

  it("rejects an extreme aspect ratio on a model without it", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3-pro-image",
      resolution: "1K",
      aspectRatio: "1:4",
    });
    expect(message).toMatch(/does not support aspect ratio '1:4'/);
  });

  it("accepts every public option on the default model", () => {
    for (const resolution of RESOLUTIONS) {
      for (const aspectRatio of ASPECT_RATIOS) {
        expect(
          getUnsupportedModelOptionMessage({
            model: DEFAULTS.model,
            resolution,
            aspectRatio,
          })
        ).toBeNull();
      }
    }
  });

  it("skips the aspect ratio check when none is given (edit 'auto')", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: "gemini-3-pro-image",
        resolution: "1K",
      })
    ).toBeNull();
  });

  it("checks resolution before aspect ratio", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3.1-flash-lite-image",
      resolution: "4K",
      aspectRatio: "8:1",
    });
    expect(message).toMatch(/resolution/);
  });
});

describe("capability registry", () => {
  it("has an entry for every model and every entry uses known tokens", () => {
    for (const model of IMAGE_MODELS) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      expect(caps).toBeDefined();
      for (const r of caps.resolutions) expect(RESOLUTIONS).toContain(r);
      for (const a of caps.aspectRatios) expect(ASPECT_RATIOS).toContain(a);
    }
  });

  it("only the default model supports the extreme aspect ratios", () => {
    for (const model of IMAGE_MODELS) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      if (model === DEFAULTS.model) {
        expect(caps.aspectRatios).toEqual(ASPECT_RATIOS);
      } else {
        expect(caps.aspectRatios).toEqual(BASE_ASPECT_RATIOS);
      }
    }
  });

  it("maps 0.5K to the API token '512' and passes the others through", () => {
    expect(IMAGE_SIZE_API_VALUES["0.5K"]).toBe("512");
    expect(IMAGE_SIZE_API_VALUES["1K"]).toBe("1K");
    expect(IMAGE_SIZE_API_VALUES["2K"]).toBe("2K");
    expect(IMAGE_SIZE_API_VALUES["4K"]).toBe("4K");
  });

  it("defaults are themselves valid for the default model", () => {
    expect(
      getUnsupportedModelOptionMessage({
        model: DEFAULTS.model,
        resolution: DEFAULTS.resolution,
        aspectRatio: DEFAULTS.aspectRatio,
      })
    ).toBeNull();
  });
});
