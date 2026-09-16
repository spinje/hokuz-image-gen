/**
 * Zod input schema for the generate_image tool
 */

import { z } from "zod";
import {
  IMAGE_MODELS,
  ASPECT_RATIOS,
  RESOLUTIONS,
  OUTPUT_FORMATS,
  QUALITIES,
  DEFAULTS,
  LIMITS,
} from "../constants.js";

/**
 * Input schema for hokuz_generate_image tool
 */
export const GenerateImageInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(
        LIMITS.maxPromptLength,
        `Prompt must not exceed ${LIMITS.maxPromptLength} characters`
      )
      .describe(
        "Text description of the image to generate. Be detailed and specific for best results."
      ),

    output_path: z
      .string()
      .min(1, "Output path is required")
      .describe(
        "Where to save the generated image. A trailing slash, or a path that is already a directory, " +
          "means a timestamped file inside it; anything else is the file to write, and its extension " +
          "is replaced to match the output format. An existing file is never overwritten (-2, -3 is " +
          "appended), so use the path returned in the result."
      ),

    model: z
      .enum(IMAGE_MODELS)
      .default(DEFAULTS.model)
      .describe(
        `Options: ${IMAGE_MODELS.join(", ")}. Gemini models: gemini-3.1-flash-lite-image (cheapest ` +
          "Gemini, 1K only), gemini-3.1-flash-image (default, 0.5K-4K, extreme ratios), " +
          "gemini-3-pro-image (highest quality). OpenAI: gpt-image-2.5-flare (fast), " +
          "gpt-image-2.5-sunburst (editing precision, text). See the tool description for cost and " +
          `when to use which. Default: ${DEFAULTS.model}`
      ),

    aspect_ratio: z
      .enum(ASPECT_RATIOS)
      .default(DEFAULTS.aspectRatio)
      .describe(
        `Aspect ratio. Options: ${ASPECT_RATIOS.join(", ")}. The extreme ratios (1:4, 4:1, 1:8, 8:1) are ` +
          "supported only by gemini-3.1-flash-image; OpenAI models accept the other ten. " +
          `Default: ${DEFAULTS.aspectRatio}`
      ),

    resolution: z
      .enum(RESOLUTIONS)
      .default(DEFAULTS.resolution)
      .describe(
        `Output resolution. Options: ${RESOLUTIONS.join(", ")}. Gemini: Lite is 1K only, Pro is 1K/2K/4K. ` +
          "OpenAI models: 1K (~1 megapixel) or 2K (~4 megapixels) only; exact pixel size is derived from " +
          `aspect_ratio and returned in the result. Default: ${DEFAULTS.resolution}`
      ),

    // No .default(): see gotcha 7. With one, the handler could not tell an
    // explicit format from a filled-in default, and could not fall back to the
    // output_path's extension.
    output_format: z
      .enum(OUTPUT_FORMATS)
      .optional()
      .describe(
        "Output file format. jpeg is produced by every model; png and webp by OpenAI models only. " +
          "Default: the extension of output_path (.jpg/.jpeg/.png/.webp) when it has one, otherwise " +
          "jpeg. The saved file's extension always matches the format."
      ),

    quality: z
      .enum(QUALITIES)
      .optional()
      .describe(
        `OpenAI models only. Options: ${QUALITIES.join(", ")}. Cost per 1K image scales roughly ` +
          "$0.006 / $0.013 / $0.05 / $0.09 / $0.21 and latency ~10-46 s (flare) or ~16-85 s (sunburst). Use low for throwaway drafts, medium for most " +
          "work, high for final assets, xhigh/max only when high visibly fails. Gemini models reject this " +
          `option. Default for OpenAI models: ${DEFAULTS.quality}`
      ),

    transparent_background: z
      .boolean()
      .optional()
      .describe(
        "OpenAI models only; requires output_format png or webp (or a .png/.webp output_path). " +
          "false is accepted on every model. Default: opaque."
      ),

    num_images: z
      .number()
      .int("Number of images must be a whole number")
      .min(1, "Must generate at least 1 image")
      .max(
        LIMITS.maxOutputImages,
        `Maximum ${LIMITS.maxOutputImages} images per request`
      )
      .default(DEFAULTS.numImages)
      .describe(
        `Number of images to generate (1-${LIMITS.maxOutputImages}). Default: ${DEFAULTS.numImages}`
      ),

    temperature: z
      .number()
      .min(
        LIMITS.minTemperature,
        `Temperature must be at least ${LIMITS.minTemperature}`
      )
      .max(
        LIMITS.maxTemperature,
        `Temperature must not exceed ${LIMITS.maxTemperature}`
      )
      .optional()
      .describe(
        `Gemini models only. Creativity/randomness (${LIMITS.minTemperature}-${LIMITS.maxTemperature}); higher is ` +
          "more varied. OpenAI models reject this option. Default for Gemini models: " +
          `${DEFAULTS.temperature}`
      ),
  })
  .strict();

/**
 * Type definition derived from the schema
 */
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;
