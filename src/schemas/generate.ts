/**
 * Zod schemas for the generate_image tool
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
        "Local file path to save the generated image. Can be a directory (filename will be auto-generated with timestamp) or a full file path."
      ),

    model: z
      .enum(IMAGE_MODELS)
      .default(DEFAULTS.model)
      .describe(
        "Image model. Google (Gemini API): 'gemini-3.1-flash-image' (Nano Banana 2, balanced default, 0.5K-4K, " +
          "extreme aspect ratios), 'gemini-3.1-flash-lite-image' (Nano Banana 2 Lite, cheapest/fastest, 1K only), " +
          "'gemini-3-pro-image' (Nano Banana Pro, highest quality, 1K-4K). OpenAI: 'gpt-image-2.5-flare' (fast, " +
          "everyday generation), 'gpt-image-2.5-sunburst' (slower, best editing precision); both 1K/2K, quality " +
          `ladder via 'quality'. Default: ${DEFAULTS.model}`
      ),

    aspect_ratio: z
      .enum(ASPECT_RATIOS)
      .default(DEFAULTS.aspectRatio)
      .describe(
        `Aspect ratio. Options: ${ASPECT_RATIOS.join(", ")}. The extreme ratios (1:4, 4:1, 1:8, 8:1) are ` +
          "supported only by gemini-3.1-flash-image; OpenAI models accept the other ten. Unsupported " +
          `combinations are rejected before the API call. Default: ${DEFAULTS.aspectRatio}`
      ),

    resolution: z
      .enum(RESOLUTIONS)
      .default(DEFAULTS.resolution)
      .describe(
        `Output resolution. Options: ${RESOLUTIONS.join(", ")}. Gemini: Lite is 1K only, Pro is 1K/2K/4K. ` +
          "OpenAI models: 1K (~1 megapixel) or 2K (~4 megapixels) only; exact pixel size is derived from " +
          "aspect_ratio and returned in the result. Unsupported model/resolution combinations are rejected " +
          `before the API call. Default: ${DEFAULTS.resolution}`
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
          "$0.006 / $0.013 / $0.05 / $0.09 / $0.21 and latency 10 s to 90 s. Use medium for drafts and most " +
          "work, high for final assets, xhigh/max only when high visibly fails. Gemini models reject this " +
          `option. Default for OpenAI models: ${DEFAULTS.quality}`
      ),

    transparent_background: z
      .boolean()
      .optional()
      .describe(
        "OpenAI models only. true renders a transparent background; requires output_format png or " +
          "webp. Gemini models reject `true`."
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

/**
 * Output schema for hokuz_generate_image tool
 */
export const GenerateImageOutputSchema = z.object({
  success: z.boolean().describe("Whether the image generation succeeded"),
  images: z
    .array(
      z.object({
        path: z.string().describe("File path where the image was saved"),
        format: z.string().describe("Image format (jpeg, png or webp)"),
        width: z
          .number()
          .optional()
          .describe("Image width in pixels, when the provider reports it"),
        height: z
          .number()
          .optional()
          .describe("Image height in pixels, when the provider reports it"),
      })
    )
    .describe("Array of generated images"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the generated image(s)"),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      estimated_cost_usd: z.number(),
    })
    .optional()
    .describe(
      "Token usage summed over the requests made, with a cost estimated from those counts (OpenAI models only)"
    ),
  warning: z
    .string()
    .optional()
    .describe(
      "Set when fewer images than requested were produced; includes the failure reason"
    ),
  error: z
    .string()
    .optional()
    .describe("Error message if generation failed"),
});

export type GenerateImageOutput = z.infer<typeof GenerateImageOutputSchema>;
