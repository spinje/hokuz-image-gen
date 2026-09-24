/**
 * Zod output schema shared by both image tools. They return the same shape:
 * the files written, delivery status, optional description/usage and recovery issue.
 */

import { z } from "zod";
import {
  ASPECT_RATIOS,
  IMAGE_MODELS,
  OUTPUT_FORMATS,
  QUALITIES,
  RESOLUTIONS,
} from "../constants.js";
import { ErrorType } from "../types.js";

/**
 * Output schema for hokuz_generate_image and hokuz_edit_image
 */
export const ImageToolOutputSchema = z.object({
  status: z.enum(["complete", "partial", "failed"]).describe(
    "Delivery outcome: complete means all requested images were saved; partial means some were saved; failed means none were saved. A failed delivery does not mean generation never happened."
  ),
  images: z
    .array(
      z.object({
        preview: z.object({
          content_index: z.number().int().min(0).describe("Zero-based index of this image's derived JPEG block in content"),
          width: z.number().int().positive().max(1024).describe("Derived preview width in pixels, not the saved image width"),
          height: z.number().int().positive().max(512).describe("Derived preview height in pixels, not the saved image height"),
          background: z.enum(["original", "white_and_navy"]).describe("original: opaque image; white_and_navy: the same image composited on white left and navy right"),
          alpha: z.object({
            has_channel: z.boolean().describe("Whether the original decoded image has an alpha channel; a channel alone does not prove transparency"),
            min: z.number().int().min(0).max(255).describe("Minimum original 8-bit alpha; 0 is fully transparent, 255 fully opaque. 255 when there is no alpha channel"),
            max: z.number().int().min(0).max(255).describe("Maximum original 8-bit alpha; 0 is fully transparent, 255 fully opaque. 255 when there is no alpha channel"),
          }).describe("Alpha measurements before resizing/compositing; not a clean-cutout or preservation guarantee"),
        }).optional().describe("Present only when include_preview produced an inline derived JPEG; the saved original remains authoritative"),
        preview_warning: z.string().optional().describe("Requested preview unavailable; the original was saved successfully. Inspect that file rather than repeating the paid image request"),
        path: z.string().describe("File path where the image was saved; authoritative, and different from output_path when a -2, -3 suffix was needed"),
        format: z.enum(OUTPUT_FORMATS).describe("Image format"),
        width: z
          .number()
          .optional()
          .describe("Delivered width in pixels (measured from the file on Gemini, as reported by the provider on OpenAI); can differ from the requested aspect ratio by a few percent"),
        height: z
          .number()
          .optional()
          .describe("Delivered height in pixels (measured from the file on Gemini, as reported by the provider on OpenAI); can differ from the requested aspect ratio by a few percent"),
      })
    )
    .describe("The images written to disk, in order"),
  settings: z
    .object({
      model: z.enum(IMAGE_MODELS).describe("Model this call's requests were built for"),
      aspect_ratio: z
        .enum(["auto", ...ASPECT_RATIOS])
        .describe("The requested target ratio, or auto (edit). A request, not a measurement: images[].width/height are the delivered size"),
      resolution: z
        .enum(RESOLUTIONS)
        .optional()
        .describe("Requested resolution; absent when an OpenAI model chose the size itself (edit with aspect_ratio auto)"),
      output_format: z.enum(OUTPUT_FORMATS).describe("Format requested and saved"),
      quality: z.enum(QUALITIES).optional().describe("OpenAI models only: the quality requested, including the default when none was given"),
      temperature: z.number().optional().describe("Gemini models only: the temperature requested, including the default when none was given"),
      transparent_background: z.boolean().optional().describe("OpenAI models only: whether a transparent background was requested"),
    })
    .optional()
    .describe("The settings this call's provider requests were built with, including provider defaults for options the call omitted; cite these rather than the call's arguments. Present whenever generation started, even if no request completed; absent when the call was rejected before that"),
  description: z
    .string()
    .optional()
    .describe("Model response text, when present, including responses that contained no image"),
  usage: z
    .object({
      input_tokens: z
        .number()
        .optional()
        .describe(
          "Prompt and input-image tokens, summed over the requests that reported them. Absent when no request's response carried a token count, which says nothing about how many were used."
        ),
      output_tokens: z
        .number()
        .optional()
        .describe("Output tokens reported by the provider, summed across responses that reported them"),
      estimated_cost_usd: z
        .number()
        .describe(
          "The total for the requests_reported requests, not the price of one image. Estimated, never billed. Read cost_basis before relating it to the token counts."
        ),
      cost_basis: z
        .enum(["tokens", "per_image"])
        .describe(
          "How estimated_cost_usd was arrived at. 'tokens': arithmetic over the counts above and a price table (OpenAI). 'per_image': Google's published price for the model and resolution (Gemini) — the counts above are real but did NOT produce this cost, and input and text tokens, a fraction of a cent, are not in it."
        ),
      requests_completed: z
        .number()
        .describe(
          "Provider requests that returned a completed response, including responses without usable images or whose images could not be saved. Request failures are excluded."
        ),
      requests_reported: z
        .number()
        .describe(
          "How many completed responses estimated_cost_usd covers. Lower than requests_completed means it is a partial view of the call, not its whole cost. Unreported charges may apply, including for failed or interrupted requests. The token counts have their own scope: each is summed only over the requests that reported it, which can be fewer still."
        ),
    })
    .optional()
    .describe("Token usage and an estimated cost for the requests that reported them"),
  issue: z.object({
    code: z.enum(ErrorType).describe("Failure category; read message and next_step for the specific outcome and recovery"),
    message: z.string().describe("What prevented completion, including any uncertainty about generation"),
    next_step: z.string().describe("What to do next; preserve saved results and request only missing images if another attempt is appropriate"),
  }).optional().describe("Present for partial or failed delivery; absent when complete"),
});

export type ImageToolOutput = z.infer<typeof ImageToolOutputSchema>;
