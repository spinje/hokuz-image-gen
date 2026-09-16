/**
 * Zod input schema for the edit_image tool
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
        "Array of local file paths or URLs to source images. Gemini models: up to 14 images, 7 MB " +
          "each (jpeg/png/webp/gif/heic/heif). OpenAI models: up to 16 images, 50 MB each, jpeg/png/webp " +
          "only (gif/heic are rejected before the API call). Order matters: 'first image'/'second " +
          "image' in the prompt refer to this order. For style transfer, provide the content image " +
          "first, then the style reference."
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
        `Options: ${IMAGE_MODELS.join(", ")}. Gemini models: gemini-3.1-flash-lite-image (cheapest ` +
          "Gemini, 1K only), gemini-3.1-flash-image (default, 0.5K-4K, extreme ratios), " +
          "gemini-3-pro-image (highest quality). OpenAI: gpt-image-2.5-flare (fast), " +
          "gpt-image-2.5-sunburst (editing precision, text). See the tool description for cost and " +
          `when to use which. Default: ${DEFAULTS.model}`
      ),

    aspect_ratio: z
      .enum(EDIT_ASPECT_RATIOS)
      .default("auto")
      .describe(
        `Aspect ratio. Options: auto, ${ASPECT_RATIOS.join(", ")}. 'auto' (default) keeps the input's ` +
          "framing on Gemini and lets OpenAI choose the size. The extreme ratios (1:4, 4:1, 1:8, 8:1) are " +
          "supported only by gemini-3.1-flash-image; OpenAI models accept the other ten. Default: auto"
      ),

    // No .default(): see gotcha 7. With one, an explicit resolution could not
    // be told from a filled-in default, and "auto" would silently ignore it.
    resolution: z
      .enum(RESOLUTIONS)
      .optional()
      .describe(
        `Output resolution: ${RESOLUTIONS.join(", ")} per model (Lite 1K only; Pro 1K/2K/4K; OpenAI ` +
          "1K/2K). Omit it unless you also set an aspect_ratio: Gemini applies 1K when omitted; on " +
          "OpenAI models with aspect_ratio 'auto' the provider chooses the size and an explicit " +
          "resolution is rejected."
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
          "false is accepted on every model."
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
