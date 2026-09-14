/**
 * Zod schemas for the edit_image tool
 */

import { z } from "zod";
import {
  IMAGE_MODELS,
  ASPECT_RATIOS,
  RESOLUTIONS,
  OUTPUT_FORMATS,
  DEFAULTS,
  LIMITS,
} from "../constants.js";

/**
 * Extended aspect ratios for editing (includes 'auto' option)
 */
const EDIT_ASPECT_RATIOS = ["auto", ...ASPECT_RATIOS] as const;

/**
 * Input schema for nanobanana_edit_image tool
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
        `Array of local file paths or URLs to source images (1-${LIMITS.maxInputImages} images). For style transfer, provide the content image first, then the style reference. For multi-image composition, provide all images to combine.`
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
        `Image model to use. Options: ${IMAGE_MODELS.join(", ")}. ` +
          `'gemini-3.1-flash-image' (Nano Banana 2) is the balanced default (0.5K/1K/2K/4K); ` +
          `'gemini-3.1-flash-lite-image' (Nano Banana 2 Lite) is cheapest/fastest (1K only); ` +
          `'gemini-3-pro-image' (Nano Banana Pro) is highest quality (1K/2K/4K). ` +
          `Default: ${DEFAULTS.model}`
      ),

    aspect_ratio: z
      .enum(EDIT_ASPECT_RATIOS)
      .default("auto")
      .describe(
        `Aspect ratio for the output image. 'auto' preserves the original aspect ratio. Options: auto, ${ASPECT_RATIOS.join(", ")}. ` +
          `The extreme ratios (1:4, 4:1, 1:8, 8:1) are only supported by gemini-3.1-flash-image; ` +
          `unsupported model/aspect combinations are rejected before the API call. Default: auto`
      ),

    resolution: z
      .enum(RESOLUTIONS)
      .default(DEFAULTS.resolution)
      .describe(
        `Output image resolution/quality. Options: ${RESOLUTIONS.join(", ")}. 4K provides highest quality. ` +
          `Supported resolutions vary by model (Lite is 1K only; Pro is 1K/2K/4K); ` +
          `unsupported model/resolution combinations are rejected before the API call. Default: ${DEFAULTS.resolution}`
      ),

    output_format: z
      .enum(OUTPUT_FORMATS)
      .default(DEFAULTS.outputFormat)
      .describe(
        `Output image format. Options: ${OUTPUT_FORMATS.join(", ")}. Default: ${DEFAULTS.outputFormat}`
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
      .default(DEFAULTS.temperature)
      .describe(
        `Creativity/randomness control (${LIMITS.minTemperature}-${LIMITS.maxTemperature}). Higher values produce more varied results. Default: ${DEFAULTS.temperature}`
      ),
  })
  .strict();

/**
 * Type definition derived from the schema
 */
export type EditImageInput = z.infer<typeof EditImageInputSchema>;

/**
 * Output schema for nanobanana_edit_image tool
 */
export const EditImageOutputSchema = z.object({
  success: z.boolean().describe("Whether the image editing succeeded"),
  images: z
    .array(
      z.object({
        path: z.string().describe("File path where the image was saved"),
        format: z.string().describe("Image format (jpeg)"),
      })
    )
    .describe("Array of edited images"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the edited image(s)"),
  error: z
    .string()
    .optional()
    .describe("Error message if editing failed"),
});

export type EditImageOutput = z.infer<typeof EditImageOutputSchema>;
