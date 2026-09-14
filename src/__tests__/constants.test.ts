import { describe, it, expect } from "vitest";
import { DEFAULTS, getUnsupportedModelOptionMessage } from "../constants.js";

describe("getUnsupportedModelOptionMessage", () => {
  it("rejects a resolution the model does not support and names the supported ones", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3.1-flash-lite-image",
      resolution: "2K",
      aspectRatio: "1:1",
    });
    expect(message).toMatch(/does not support resolution '2K'/);
    expect(message).toMatch(/Supported resolutions: 1K\./);
  });

  it("rejects an extreme aspect ratio on a model without it", () => {
    const message = getUnsupportedModelOptionMessage({
      model: "gemini-3-pro-image",
      resolution: "1K",
      aspectRatio: "1:4",
    });
    expect(message).toMatch(/does not support aspect ratio '1:4'/);
  });

  it("skips the aspect ratio check when none is given (edit 'auto')", () => {
    // Pro does not support the extreme ratios; with no ratio at all it must still pass.
    expect(
      getUnsupportedModelOptionMessage({ model: "gemini-3-pro-image", resolution: "1K" })
    ).toBeNull();
  });

  it("the shipped defaults are a valid combination for the default model", () => {
    // Guards against someone changing DEFAULTS.model or DEFAULTS.resolution
    // independently and shipping a server whose default call is rejected.
    expect(
      getUnsupportedModelOptionMessage({
        model: DEFAULTS.model,
        resolution: DEFAULTS.resolution,
        aspectRatio: DEFAULTS.aspectRatio,
      })
    ).toBeNull();
  });
});
