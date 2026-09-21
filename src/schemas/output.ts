/**
 * Zod output schema shared by both image tools. They return the same shape:
 * the files written, an optional description, usage and warning, or the error.
 */

import { z } from "zod";
import { OUTPUT_FORMATS } from "../constants.js";
import { ErrorType } from "../types.js";

/**
 * Output schema for hokuz_generate_image and hokuz_edit_image
 */
export const ImageToolOutputSchema = z.object({
  success: z.boolean().describe("Whether the call succeeded"),
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
          "Provider requests that returned an image; num_images makes one request per image. A request that failed is not counted here and is described in warning instead."
        ),
      requests_reported: z
        .number()
        .describe(
          "How many of those requests estimated_cost_usd covers. Lower than requests_succeeded means it is a partial view of the call, not its whole cost. The token counts have their own scope: each is summed only over the requests that reported it, which can be fewer still."
        ),
    })
    .optional()
    .describe("Token usage and an estimated cost for the requests that reported them"),
  warning: z
    .string()
    .optional()
    .describe(
      "Set when fewer images than requested were produced. The call still succeeds and images holds what was produced, so retry only the shortfall. Carries the failing request's reason."
    ),
  error: z
    .string()
    .optional()
    .describe("Error message when the call failed; starts with 'Error:'"),
  error_type: z
    .enum(ErrorType)
    .optional()
    .describe(
      "Why the call failed, for choosing the next step. SERVER_BUSY: another image call is active; wait for it to finish before retrying. REQUEST_CANCELLED: the caller cancelled; do not automatically retry. INVALID_MODEL_OPTION, INVALID_IMAGE_PATH, IMAGE_TOO_LARGE: fix the arguments. CONTENT_BLOCKED: rephrase the prompt or change the input images. API_RATE_LIMIT: wait, then retry. MISSING_API_KEY: the provider's key is missing, invalid or denied; use the other provider. API_ERROR: the provider failed the request; read retryable rather than guessing from the message. FILE_WRITE_ERROR: fix output_path. UNKNOWN_ERROR: unexpected."
    ),
  retryable: z
    .boolean()
    .optional()
    .describe(
      "Whether repeating the identical call could succeed. false means it cannot: change the arguments, the prompt, or the server's configuration first. Wait before retrying API_RATE_LIMIT; for SERVER_BUSY, wait for the active image call to finish."
    ),
});

export type ImageToolOutput = z.infer<typeof ImageToolOutputSchema>;
