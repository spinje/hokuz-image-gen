/**
 * The expected-output-size text both aspect_ratio describe strings carry.
 * Every number comes from `expectedSize`, the same function that fills
 * `settings.expected_size`, so the published list cannot drift from the result.
 */

import { IMAGE_MODEL_CAPABILITIES, type AspectRatio, type ImageModel, type Resolution } from "../constants.js";
import { expectedSize } from "../providers/index.js";

/** Throws while the module loads (the server refuses to start) rather than publish a gap. */
function sizeOf(model: ImageModel, aspectRatio: AspectRatio, resolution: Resolution): string {
  const size = expectedSize({ model, aspectRatio, resolution, outputFormat: "jpeg" });
  if (size === undefined) throw new Error(`No expected size for ${model} ${aspectRatio} ${resolution}`);
  return size;
}

/** "1:1 1024x1024, 2:3 848x1264, ..." for every ratio the model supports, at 1K. */
function sizesAt1K(model: ImageModel): string {
  return IMAGE_MODEL_CAPABILITIES[model].aspectRatios
    .map((aspectRatio) => `${aspectRatio} ${sizeOf(model, aspectRatio, "1K")}`)
    .join(", ");
}

// One model per provider: Gemini sizes were measured on Flash (Pro and Lite
// matched in spot checks), and both OpenAI models derive the size alike.
export const OUTPUT_SIZES_DESCRIPTION =
  `Expected output size (WxH) at 1K. Gemini (measured on Flash for every ratio; Pro and Lite matched in spot checks): ${sizesAt1K("gemini-3.1-flash-image")}. ` +
  `OpenAI (exact; the size requested): ${sizesAt1K("gpt-image-2.5-flare")}. ` +
  `2K: Gemini exactly doubles both edges (verified on Flash and Pro); OpenAI 16:9 is ${sizeOf("gpt-image-2.5-flare", "16:9", "2K")}. ` +
  "Gemini 0.5K and 4K: no measured size is published (the ratio is still applied). The result echoes the expectation as settings.expected_size " +
  "and each image's ratio error as images[].aspect_error_pct; resize or crop when an exact ratio matters.";
