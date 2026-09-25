import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  GEMINI_PRICE_PER_IMAGE_USD,
  IMAGE_MODELS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedInputImage,
  getUnsupportedModelOption,
  nearestAspectRatio,
  type Quality,
} from "../constants.js";

describe("getUnsupportedModelOption", () => {
  it("rejects a resolution the model does not support and names the supported ones", () => {
    const message = getUnsupportedModelOption({
      model: "gemini-3.1-flash-lite-image",
      resolution: "2K",
      aspectRatio: "1:1",
    });
    expect(`${message?.message} ${message?.next_step}`).toMatch(/does not support resolution '2K'/);
    expect(`${message?.message} ${message?.next_step}`).toMatch(/Supported resolutions: 1K\./);
    expect(`${message?.message} ${message?.next_step}`).toMatch(/or a model that supports '2K': gemini-3\.1-flash-image, gemini-3-pro-image, gpt-image-2\.5-flare, gpt-image-2\.5-sunburst\.$/);
  });

  it("rejects a resolution outside the OpenAI 1K/2K band", () => {
    const message = getUnsupportedModelOption({
      model: "gpt-image-2.5-flare",
      resolution: "4K",
      aspectRatio: "1:1",
    });
    expect(`${message?.message} ${message?.next_step}`).toMatch(/does not support resolution '4K'/);
    expect(`${message?.message} ${message?.next_step}`).toMatch(/Supported resolutions: 1K, 2K\./);
  });

  it("rejects an extreme aspect ratio on a model without it", () => {
    const message = getUnsupportedModelOption({
      model: "gemini-3-pro-image",
      resolution: "1K",
      aspectRatio: "1:4",
    });
    expect(`${message?.message} ${message?.next_step}`).toMatch(/does not support aspect ratio '1:4'/);
    expect(`${message?.message} ${message?.next_step}`).toMatch(/or a model that supports '1:4': gemini-3\.1-flash-image\.$/);
  });

  it("skips the aspect ratio check when none is given (edit 'auto')", () => {
    // Pro does not support the extreme ratios; with no ratio at all it must still pass.
    expect(
      getUnsupportedModelOption({ model: "gemini-3-pro-image", resolution: "1K" })
    ).toBeNull();
  });

  it("rejects an explicit resolution with edit 'auto' on OpenAI, which derives size from the ratio", () => {
    expect(
      getUnsupportedModelOption({ model: "gpt-image-2.5-flare", resolution: "2K" })
    ).toEqual(
      { message: "Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) cannot apply resolution '2K' when aspect_ratio is 'auto' because the provider chooses the output size.", next_step: "Set an aspect_ratio to control the size (match_input keeps the first image's shape), or omit resolution." }
    );
    // Gemini applies the resolution whatever the ratio, so the same call is fine there.
    expect(
      getUnsupportedModelOption({ model: "gemini-3.1-flash-image", resolution: "2K" })
    ).toBeNull();
  });

  it("rejects an output format the model cannot produce, naming the models that can", () => {
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "png",
      })
    ).toEqual(
      { message: "Model 'gemini-3.1-flash-image' (Nano Banana 2) does not support output_format 'png'.", next_step: "Use jpeg, or a model that supports 'png': gpt-image-2.5-flare, gpt-image-2.5-sunburst." }
    );
    // The same call on a model that produces all three is fine.
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "png",
      })
    ).toBeNull();
  });

  it("rejects transparent_background on a model without it, naming the models with it", () => {
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "jpeg",
        transparentBackground: true,
      })
    ).toEqual(
      { message: "Model 'gemini-3.1-flash-image' (Nano Banana 2) does not support transparent_background.", next_step: "Use a model that supports it (gpt-image-2.5-flare, gpt-image-2.5-sunburst) with output_format png or webp." }
    );
    // transparent_background: false asks for what every model already does.
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "jpeg",
        transparentBackground: false,
      })
    ).toBeNull();
  });

  it("rejects transparent_background with jpeg, which has no alpha channel", () => {
    // Live behaviour: the API returns a hard 400 for this combination.
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "jpeg",
        transparentBackground: true,
      })
    ).toEqual(
      { message: "transparent_background requires output_format 'png' or 'webp' (JPEG has no alpha channel).", next_step: "Set output_format accordingly, or omit transparent_background." }
    );
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        outputFormat: "webp",
        transparentBackground: true,
      })
    ).toBeNull();
  });

  it("rejects more input images than the model accepts, naming its limit", () => {
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        aspectRatio: "1:1",
        inputImageCount: 15,
      })
    ).toEqual(
      { message: "Model 'gemini-3.1-flash-image' (Nano Banana 2) accepts at most 14 input images; 15 were given.", next_step: "Remove images, or use an OpenAI model (up to 16)." }
    );
    // The limit itself is accepted on both, one below the message above.
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        aspectRatio: "1:1",
        inputImageCount: 14,
      })
    ).toBeNull();
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        inputImageCount: 16,
      })
    ).toBeNull();
    // 15 is within the OpenAI limit; 17 is beyond every model, so there is no
    // other model to point at.
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        inputImageCount: 15,
      })
    ).toBeNull();
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        inputImageCount: 17,
      })
    ).toEqual(
      { message: "Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) accepts at most 16 input images; 17 were given.", next_step: "Remove images." }
    );
  });

  it("rejects a quality outside the model's ladder, naming the supported ones", () => {
    // The enum keeps this out of a real call; the check must still test the
    // list rather than "does this model have any qualities at all".
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        quality: "ultra" as unknown as Quality,
      })
    ).toEqual(
      { message: "Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not support quality 'ultra'.", next_step: "Choose one of these qualities: low, medium, high, xhigh, max." }
    );
  });

  it("rejects 'quality' on a model that has no quality ladder, naming the alternative", () => {
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        quality: "high",
      })
    ).toEqual(
      { message: "Model 'gemini-3.1-flash-image' (Nano Banana 2) does not accept 'quality'; it is an OpenAI-only option.", next_step: "Omit it, or use a model that accepts it: gpt-image-2.5-flare, gpt-image-2.5-sunburst." }
    );
  });

  it("rejects 'temperature' on a model that does not take one, naming the alternative", () => {
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-sunburst",
        resolution: "1K",
        aspectRatio: "1:1",
        temperature: 0.2,
      })
    ).toEqual(
      { message: "Model 'gpt-image-2.5-sunburst' (GPT Image 2.5 Sunburst) does not accept 'temperature'; it is a Gemini-only option.", next_step: "Omit it, or use a model that accepts it: gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image." }
    );
  });

  it("accepts a temperature of 0, which is a real value and not an absent option", () => {
    expect(
      getUnsupportedModelOption({
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        temperature: 0,
      })
    ).toBeNull();
    expect(
      getUnsupportedModelOption({
        model: "gpt-image-2.5-flare",
        resolution: "1K",
        aspectRatio: "1:1",
        temperature: 0,
      })
    ).toMatchObject({ message: expect.stringContaining("does not accept 'temperature'") });
  });

  it("the shipped defaults are a valid call for every model in the registry", () => {
    // Guards against a new model, or a changed DEFAULT, whose default call the
    // server would reject. The providers apply DEFAULTS.temperature and
    // DEFAULTS.quality themselves, so those must be valid for them too.
    for (const model of IMAGE_MODELS) {
      const caps = IMAGE_MODEL_CAPABILITIES[model];
      expect({
        model,
        message: getUnsupportedModelOption({
          model,
          resolution: DEFAULTS.resolution,
          aspectRatio: DEFAULTS.aspectRatio,
          outputFormat: DEFAULTS.outputFormat,
        }),
      }).toEqual({ model, message: null });
      expect({
        model,
        qualityOk: caps.qualities.length === 0 || caps.qualities.includes(DEFAULTS.quality),
      }).toEqual({ model, qualityOk: true });
    }
  });
});

describe("getUnsupportedInputImage", () => {
  it("rejects an input type the model does not accept, naming the ones it does", () => {
    // Live behaviour: OpenAI returns a 400 for GIF before generating anything.
    expect(
      getUnsupportedInputImage({
        model: "gpt-image-2.5-flare",
        mimeType: "image/gif",
        path: "~/pics/loop.gif",
      })
    ).toEqual(
      { message: "Model 'gpt-image-2.5-flare' (GPT Image 2.5 Flare) does not accept image/gif input ('~/pics/loop.gif'). Supported input formats: jpeg, png, webp.", next_step: "Convert the image, or use a Gemini model." }
    );
    // Gemini takes the same file, so it must not be told to switch to Gemini.
    expect(
      getUnsupportedInputImage({
        model: "gemini-3.1-flash-image",
        mimeType: "image/gif",
        path: "~/pics/loop.gif",
      })
    ).toBeNull();
    expect(
      getUnsupportedInputImage({
        model: "gemini-3.1-flash-image",
        mimeType: "image/bmp",
        path: "~/pics/old.bmp",
      })
    ).toEqual(
      { message: "Model 'gemini-3.1-flash-image' (Nano Banana 2) does not accept image/bmp input ('~/pics/old.bmp'). Supported input formats: jpeg, png, webp, gif, heic, heif.", next_step: "Convert the image." }
    );
  });
});

describe("GEMINI_PRICE_PER_IMAGE_USD", () => {
  it("prices exactly the resolutions the Gemini models support, and no other model", () => {
    // The provider looks the price up by model + resolution and reports no
    // usage at all when it misses, so a gap here is a silently costless result;
    // a row for an OpenAI model would be a price nothing bills against.
    const geminiModels = IMAGE_MODELS.filter(
      (model) => IMAGE_MODEL_CAPABILITIES[model].provider === "google"
    );
    expect(Object.keys(GEMINI_PRICE_PER_IMAGE_USD).sort()).toEqual([...geminiModels].sort());

    for (const model of geminiModels) {
      expect({
        model,
        priced: Object.keys(GEMINI_PRICE_PER_IMAGE_USD[model] ?? {}).sort(),
      }).toEqual({
        model,
        priced: [...IMAGE_MODEL_CAPABILITIES[model].resolutions].sort(),
      });
    }
  });
});

describe("nearestAspectRatio", () => {
  it("picks the exact ratio, or the nearest one, in the input's orientation", () => {
    expect(nearestAspectRatio("gemini-3.1-flash-image", 1024, 1024)).toBe("1:1");
    expect(nearestAspectRatio("gemini-3.1-flash-image", 1920, 1080)).toBe("16:9");
    // The input from the usability study: 1.339 is 4:3 (1.333), not 5:4 or 3:2.
    expect(nearestAspectRatio("gpt-image-2.5-flare", 1200, 896)).toBe("4:3");
    // The same shape turned portrait.
    expect(nearestAspectRatio("gpt-image-2.5-flare", 896, 1200)).toBe("3:4");
    // 0.72 sits between 2:3 (0.667) and 3:4 (0.75), nearer 3:4 by log distance.
    expect(nearestAspectRatio("gemini-3.1-flash-lite-image", 720, 1000)).toBe("3:4");
  });

  it("chooses only among the model's own ratios, so the extremes differ by model", () => {
    // 1:7 is nearest 1:8 where it exists; elsewhere the narrowest base portrait ratio.
    expect(nearestAspectRatio("gemini-3.1-flash-image", 100, 700)).toBe("1:8");
    expect(nearestAspectRatio("gemini-3-pro-image", 100, 700)).toBe("9:16");
    expect(nearestAspectRatio("gpt-image-2.5-sunburst", 100, 700)).toBe("9:16");
    expect(nearestAspectRatio("gpt-image-2.5-sunburst", 5000, 400)).toBe("21:9");
    for (const model of IMAGE_MODELS) {
      for (const [w, h] of [[1, 1], [3000, 10], [10, 3000], [1234, 567]]) {
        expect(IMAGE_MODEL_CAPABILITIES[model].aspectRatios).toContain(nearestAspectRatio(model, w, h));
      }
    }
  });

  it("breaks an exact tie toward the ratio listed first in ASPECT_RATIOS", () => {
    // 3:8 (0.375) is exactly a factor of 1.5 from both 9:16 (0.5625) and 1:4 (0.25).
    expect(nearestAspectRatio("gemini-3.1-flash-image", 300, 800)).toBe("9:16");
  });
});
