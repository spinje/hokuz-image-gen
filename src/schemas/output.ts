/**
 * Zod output schema shared by both image tools. They return the same shape:
 * the files written, delivery status, optional description/usage and recovery issue.
 */

import { z } from "zod";
import { OUTPUT_FORMATS } from "../constants.js";
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
          .describe("Image width in pixels"),
        height: z
          .number()
          .optional()
          .describe("Image height in pixels"),
      })
    )
    .describe("The images written to disk, in order"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the result, when it gave one"),
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
        .describe("Generated-image tokens, summed over the requests that reported them"),
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
      requests_succeeded: z
        .number()
        .describe(
          "Provider requests that returned an image; num_images makes one request per image. A request that failed is not counted here. Saving can fail after a request succeeds."
        ),
      requests_reported: z
        .number()
        .describe(
          "How many of those requests estimated_cost_usd covers. Lower than requests_succeeded means it is a partial view of the call, not its whole cost. Failed or interrupted requests can incur charges that are not included. The token counts have their own scope: each is summed only over the requests that reported it, which can be fewer still."
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
