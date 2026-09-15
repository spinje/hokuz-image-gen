/**
 * Provider dispatch.
 *
 * Tools talk only to this module: it validates a config against the capability
 * registry and then hands the request to the provider that owns the model.
 */

import {
  ENV_VARS,
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedModelOptionMessage,
  type ImageModel,
  type Provider,
} from "../constants.js";
import {
  type GenerationConfig,
  type ImageResponse,
  type InputImage,
  McpError,
  ErrorType,
} from "../types.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";

/**
 * Throw INVALID_MODEL_OPTION before any provider request is made.
 */
export function validateGenerationConfig(config: GenerationConfig): void {
  const message = getUnsupportedModelOptionMessage({
    model: config.model,
    resolution: config.resolution,
    aspectRatio: config.aspectRatio,
    quality: config.quality,
    temperature: config.temperature,
  });
  if (message) {
    throw new McpError(ErrorType.INVALID_MODEL_OPTION, message);
  }
}

function providerFor(model: ImageModel) {
  return IMAGE_MODEL_CAPABILITIES[model].provider === "openai" ? openai : gemini;
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig
): Promise<ImageResponse> {
  validateGenerationConfig(config);
  return providerFor(config.model).generateImage(prompt, config);
}

/**
 * Edit images using a text prompt.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig
): Promise<ImageResponse> {
  validateGenerationConfig(config);
  return providerFor(config.model).editImage(prompt, inputImages, config);
}

/**
 * Providers whose API key is present in the environment. The server refuses to
 * start with none, and names the enabled ones in its startup banner.
 */
export function enabledProviders(): Provider[] {
  const enabled: Provider[] = [];
  if (process.env[ENV_VARS.geminiApiKey] || process.env[ENV_VARS.googleApiKey]) {
    enabled.push("google");
  }
  if (process.env[ENV_VARS.openaiApiKey]) {
    enabled.push("openai");
  }
  return enabled;
}
