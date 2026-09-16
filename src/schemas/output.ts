/**
 * Zod output schema shared by both image tools. They return the same shape:
 * the files written, an optional description, usage and warning, or the error.
 */

import { z } from "zod";
import { OUTPUT_FORMATS } from "../constants.js";

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
          .describe("Image width in pixels, when the provider reports it"),
        height: z
          .number()
          .optional()
          .describe("Image height in pixels, when the provider reports it"),
      })
    )
    .describe("The images written to disk, in order"),
  description: z
    .string()
    .optional()
    .describe("Model's text description of the result, when it gave one"),
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
    .describe("Error message when the call failed; starts with 'Error:'"),
});

export type ImageToolOutput = z.infer<typeof ImageToolOutputSchema>;
