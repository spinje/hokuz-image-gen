/**
 * Zod schemas for the edit_image tool
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
 * Extended aspect ratios for editing (includes 'auto' option)
 */
const EDIT_ASPECT_RATIOS = ["auto", ...ASPECT_RATIOS] as const;

/**
 * Input schema for hokuz_edit_image tool
 */
export const EditImageInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(
        LIMITS.maxPromptLength,
        `Prompt must not exceed ${LIMITS.maxPromptLength} characters`
      )
      .describe(
        "Editing instruction describing what changes to make to the image(s). Examples: 'Make it look like a watercolor painting', 'Remove the background', 'Apply the style of the second image to the first'."
      ),

    image_paths: z
      .array(z.string())
      .min(1, "At least one image path is required")
      .max(
        LIMITS.maxInputImages,
        `Maximum ${LIMITS.maxInputImages} input images allowed`
      )
      .describe(
        `Array of local file paths or URLs to source images (1-${LIMITS.maxInputImages} images, 7 MB each). ` +
          "Order matters: 'first image'/'second image' in the prompt refer to this order. For style transfer, " +
          "provide the content image first, then the style reference."
      ),

    output_path: z
      .string()
      .min(1, "Output path is required")
      .describe(
        "Local file path to save the edited image. Can be a directory (filename will be auto-generated with timestamp) or a full file path."
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
      .enum(EDIT_ASPECT_RATIOS)
      .default("auto")
      .describe(
        `Aspect ratio. Options: auto, ${ASPECT_RATIOS.join(", ")}. 'auto' keeps the input's ratio (on OpenAI ` +
          "models the provider then chooses the output size, so an explicit resolution is rejected). The extreme ratios " +
          "(1:4, 4:1, 1:8, 8:1) are supported only by gemini-3.1-flash-image; OpenAI models accept the other " +
          "ten. Unsupported combinations are rejected before the API call. Default: auto"
      ),

    // No .default(): see gotcha 8. With one, an explicit resolution could not
    // be told from a filled-in default, and "auto" would silently ignore it.
    resolution: z
      .enum(RESOLUTIONS)
      .optional()
      .describe(
        `Output resolution. Options: ${RESOLUTIONS.join(", ")} per model (Gemini: Lite is 1K only, ` +
          "Pro is 1K/2K/4K; OpenAI models: 1K or 2K, about 1 and 4 megapixels). Default: " +
          `${DEFAULTS.resolution}. On OpenAI models with aspect_ratio 'auto' the provider chooses the ` +
          "output size, so set an aspect_ratio to control the size; combining 'auto' with an explicit " +
          "resolution is rejected. Unsupported combinations are rejected before the API call."
      ),

    output_format: z
      .enum(OUTPUT_FORMATS)
      .default(DEFAULTS.outputFormat)
      .describe(
        `Output file format. Options: ${OUTPUT_FORMATS.join(", ")} — every model produces jpeg. ` +
          `The output_path extension is replaced to match. Default: ${DEFAULTS.outputFormat}`
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
        `Number of output variations to generate (1-${LIMITS.maxOutputImages}). Default: ${DEFAULTS.numImages}`
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
export type EditImageInput = z.infer<typeof EditImageInputSchema>;

/**
 * Output schema for hokuz_edit_image tool
 */
export const EditImageOutputSchema = z.object({
  success: z.boolean().describe("Whether the image editing succeeded"),
  images: z
    .array(
      z.object({
        path: z.string().describe("File path where the image was saved"),
        format: z.string().describe("Image format (jpeg)"),
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
    .describe("Array of edited images"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the edited image(s)"),
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
    .describe("Error message if editing failed"),
});

export type EditImageOutput = z.infer<typeof EditImageOutputSchema>;
