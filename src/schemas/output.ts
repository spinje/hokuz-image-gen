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
        .describe("Prompt and input-image tokens, summed over the requests that reported them"),
      output_tokens: z
        .number()
        .optional()
        .describe("Generated-image tokens, summed over the requests that reported them"),
      estimated_cost_usd: z
        .number()
        .describe("Estimated, never billed. Read cost_basis before relating it to the token counts."),
      cost_basis: z
        .enum(["tokens", "per_image"])
        .describe(
          "How estimated_cost_usd was arrived at. 'tokens': arithmetic over the counts above and a price table (OpenAI). 'per_image': Google's published price for the model and resolution (Gemini) — the counts above are real but did NOT produce this cost, and input and text tokens, a fraction of a cent, are not in it."
        ),
      requests_made: z
        .number()
        .describe("Provider requests this call made; num_images makes one per image"),
      requests_reported: z
        .number()
        .describe(
          "How many of those requests these totals cover. Lower than requests_made means the figures are a partial view of the call, not its whole cost."
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
      "Why the call failed, for choosing the next step. INVALID_MODEL_OPTION, INVALID_IMAGE_PATH, IMAGE_TOO_LARGE: fix the arguments. CONTENT_BLOCKED: rephrase the prompt or change the input images. API_RATE_LIMIT: wait, then retry. MISSING_API_KEY: the provider's key is missing, invalid or denied; use the other provider. API_ERROR: read `error` — retry when it names a network or 5xx failure, otherwise fix the arguments it names or switch model. FILE_WRITE_ERROR: fix output_path. UNKNOWN_ERROR: unexpected."
    ),
});

export type ImageToolOutput = z.infer<typeof ImageToolOutputSchema>;
