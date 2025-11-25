/**
 * Gemini API Client for Nano Banana Pro image generation
 */

import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import {
  MODEL_ID,
  ENV_VARS,
  type AspectRatio,
  type Resolution,
} from "../constants.js";
import {
  type GeminiImageResponse,
  type GeneratedImage,
  type InputImage,
  McpError,
  ErrorType,
} from "../types.js";

/**
 * Configuration for image generation
 */
export interface GenerationConfig {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  temperature: number;
  numImages: number;
}

/**
 * Get the API key from environment variables
 */
function getApiKey(): string {
  const apiKey =
    process.env[ENV_VARS.googleApiKey] || process.env[ENV_VARS.geminiApiKey];

  if (!apiKey) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      `Error: API key not found. Set the ${ENV_VARS.googleApiKey} or ${ENV_VARS.geminiApiKey} environment variable. Get your key at https://aistudio.google.com/`
    );
  }

  return apiKey;
}

/**
 * Singleton Gemini client instance
 */
let clientInstance: GoogleGenAI | null = null;

/**
 * Get or create the Gemini client
 */
function getClient(): GoogleGenAI {
  if (!clientInstance) {
    const apiKey = getApiKey();
    clientInstance = new GoogleGenAI({ apiKey });
  }
  return clientInstance;
}

/**
 * Build the generation configuration for the API request
 */
function buildGenerationConfig(config: GenerationConfig) {
  return {
    temperature: config.temperature,
    responseModalities: ["TEXT", "IMAGE"] as string[],
    // Note: aspectRatio and resolution are passed via imageConfig in some SDK versions
    // We'll include them in the content request if needed
  };
}

/**
 * Parse the API response to extract images and text
 */
function parseResponse(response: unknown): GeminiImageResponse {
  const images: GeneratedImage[] = [];
  let description: string | undefined;

  // The response structure from @google/genai
  const resp = response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: {
            mimeType: string;
            data: string;
          };
        }>;
      };
    }>;
  };

  if (!resp.candidates || resp.candidates.length === 0) {
    throw new McpError(
      ErrorType.API_ERROR,
      "Error: No response candidates returned from the API. The request may have been blocked."
    );
  }

  for (const candidate of resp.candidates) {
    const parts = candidate.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData) {
        images.push({
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      } else if (part.text) {
        description = description
          ? `${description}\n${part.text}`
          : part.text;
      }
    }
  }

  if (images.length === 0) {
    // Check if content was blocked
    throw new McpError(
      ErrorType.CONTENT_BLOCKED,
      "Error: No images were generated. The content may have been blocked by safety filters. Try modifying your prompt."
    );
  }

  return { images, description };
}

/**
 * Generate images from a text prompt
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig
): Promise<GeminiImageResponse> {
  const client = getClient();

  try {
    // Build the request with image generation configuration
    const generationConfig = buildGenerationConfig(config);

    // Create the content parts - include aspect ratio and resolution in the prompt context
    // as some SDK versions handle these differently
    const enhancedPrompt = `${prompt}

[Image settings: aspect ratio ${config.aspectRatio}, resolution ${config.resolution}]`;

    const response = await client.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: "user",
          parts: [{ text: enhancedPrompt }],
        },
      ],
      config: {
        ...generationConfig,
        // Safety settings with minimum restrictions - use SDK enums
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      },
    });

    return parseResponse(response);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Edit images using a text prompt
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig
): Promise<GeminiImageResponse> {
  const client = getClient();

  try {
    const generationConfig = buildGenerationConfig(config);

    // Build content parts with images and prompt
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    // Add input images first
    for (const image of inputImages) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data,
        },
      });
    }

    // Add the editing prompt with settings
    const enhancedPrompt = `${prompt}

[Image settings: aspect ratio ${config.aspectRatio}, resolution ${config.resolution}]`;
    parts.push({ text: enhancedPrompt });

    const response = await client.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      config: {
        ...generationConfig,
        // Safety settings with minimum restrictions - use SDK enums
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      },
    });

    return parseResponse(response);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Handle API errors and convert to McpError
 */
function handleApiError(error: unknown): never {
  // Check for specific error types
  if (error instanceof McpError) {
    throw error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  // Check for rate limiting
  if (
    errorMessage.includes("429") ||
    errorMessage.toLowerCase().includes("rate limit")
  ) {
    throw new McpError(
      ErrorType.API_RATE_LIMIT,
      "Error: Rate limit exceeded. Please wait before making more requests."
    );
  }

  // Check for authentication errors
  if (
    errorMessage.includes("401") ||
    errorMessage.includes("403") ||
    errorMessage.toLowerCase().includes("api key")
  ) {
    throw new McpError(
      ErrorType.MISSING_API_KEY,
      "Error: Invalid or missing API key. Please check your GOOGLE_API_KEY environment variable."
    );
  }

  // Check for content safety blocks
  if (
    errorMessage.toLowerCase().includes("blocked") ||
    errorMessage.toLowerCase().includes("safety")
  ) {
    throw new McpError(
      ErrorType.CONTENT_BLOCKED,
      "Error: Content was blocked by safety filters. Try modifying your prompt to be less explicit or controversial."
    );
  }

  // Generic API error
  throw new McpError(
    ErrorType.API_ERROR,
    `Error: API request failed. ${errorMessage}`,
    error
  );
}

/**
 * Validate that the client can be initialized (checks for API key)
 */
export function validateApiKey(): void {
  getApiKey();
}
