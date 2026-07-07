/**
 * Zod schemas for the generate_image tool
 */

import { z } from "zod";
import {
  ASPECT_RATIOS,
  RESOLUTIONS,
  OUTPUT_FORMATS,
  DEFAULTS,
  LIMITS,
} from "../constants.js";

/**
 * Input schema for nanobanana_generate_image tool
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

    aspect_ratio: z
      .enum(ASPECT_RATIOS)
      .default(DEFAULTS.aspectRatio)
      .describe(
        `Aspect ratio for the generated image. Options: ${ASPECT_RATIOS.join(", ")}. Default: ${DEFAULTS.aspectRatio}`
      ),

    resolution: z
      .enum(RESOLUTIONS)
      .default(DEFAULTS.resolution)
      .describe(
        `Image resolution/quality. Options: ${RESOLUTIONS.join(", ")}. 4K provides highest quality. Default: ${DEFAULTS.resolution}`
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
      .default(DEFAULTS.temperature)
      .describe(
        `Creativity/randomness control (${LIMITS.minTemperature}-${LIMITS.maxTemperature}). Higher values produce more creative/varied results. Default: ${DEFAULTS.temperature}`
      ),
  })
  .strict();

/**
 * Type definition derived from the schema
 */
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;

/**
 * Output schema for nanobanana_generate_image tool
 */
export const GenerateImageOutputSchema = z.object({
  success: z.boolean().describe("Whether the image generation succeeded"),
  images: z
    .array(
      z.object({
        path: z
          .string()
          .optional()
          .describe("File path where image was saved (if output_path was provided)"),
        dataUrl: z
          .string()
          .optional()
          .describe("Base64 data URL of the image (if no output_path was provided)"),
        format: z.string().describe("Image format (png, jpeg, webp)"),
      })
    )
    .describe("Array of generated images"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the generated image(s)"),
  error: z
    .string()
    .optional()
    .describe("Error message if generation failed"),
});

export type GenerateImageOutput = z.infer<typeof GenerateImageOutputSchema>;
