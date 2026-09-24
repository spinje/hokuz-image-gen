/**
 * Provider dispatch.
 *
 * Tools talk only to this module: it validates a config against the capability
 * registry and then hands the request to the provider that owns the model.
 */

import {
  IMAGE_MODEL_CAPABILITIES,
  getUnsupportedModelOption,
  type ImageModel,
  type Provider,
} from "../constants.js";
import {
  type GenerationConfig,
  type ImageResponse,
  type InputImage,
  ToolError,
  ErrorType,
} from "../types.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";

/**
 * Throw INVALID_MODEL_OPTION before any provider request is made — and, for an
 * edit, before any input image is loaded.
 */
export function validateGenerationConfig(
  config: GenerationConfig,
  options: { inputImageCount?: number } = {}
): void {
  const issue = getUnsupportedModelOption({
    model: config.model,
    resolution: config.resolution,
    aspectRatio: config.aspectRatio,
    outputFormat: config.outputFormat,
    quality: config.quality,
    temperature: config.temperature,
    transparentBackground: config.transparentBackground,
    inputImageCount: options.inputImageCount,
  });
  if (issue) {
    throw new ToolError(ErrorType.INVALID_MODEL_OPTION, issue.message, issue.next_step);
  }
}

/**
 * What every provider module exports. Adding a provider is a `Provider` union
 * member plus one entry in the table below.
 */
export interface ProviderModule {
  /** Human-readable name, for the startup banner. */
  label: string;
  /** Whether this provider's API key is set; never throws. */
  hasApiKey(): boolean;
  getApiKey(model: ImageModel): string;
  /** The config a request is built from: the provider's defaults applied to the options it owns. */
  effectiveConfig(config: GenerationConfig): GenerationConfig;
  /** The "WxH" a request built from this config is expected to deliver; undefined when the provider chooses. */
  expectedSize(config: GenerationConfig): string | undefined;
  generateImage(prompt: string, config: GenerationConfig, signal?: AbortSignal): Promise<ImageResponse>;
  editImage(
    prompt: string,
    inputImages: InputImage[],
    config: GenerationConfig,
    signal?: AbortSignal
  ): Promise<ImageResponse>;
}

const PROVIDERS: Record<Provider, ProviderModule> = { google: gemini, openai };

function providerFor(model: ImageModel): ProviderModule {
  return PROVIDERS[IMAGE_MODEL_CAPABILITIES[model].provider];
}

/** Check local configuration before loading potentially large edit inputs. */
export function requireProviderKey(model: ImageModel): void {
  providerFor(model).getApiKey(model);
}

/**
 * The settings every request of this call is sent with, including the
 * provider's defaults for the options the caller omitted. The provider builds
 * its requests from the same function, so what the tools echo is what was sent.
 */
export function effectiveConfig(config: GenerationConfig): GenerationConfig {
  return providerFor(config.model).effectiveConfig(config);
}

/**
 * The pixel size ("WxH") this config's requests are expected to deliver: on
 * OpenAI the size sent, on Gemini the measured output grid. Undefined when the
 * provider chooses the size. The single source for both the aspect_ratio
 * describe strings and `settings.expected_size`. Gemini returns a size only
 * for combinations its model supports; OpenAI returns one for any ratio and
 * resolution (no capability gating), so callers reach it only after
 * `validateGenerationConfig` has rejected unsupported ones.
 */
export function expectedSize(config: GenerationConfig): string | undefined {
  return providerFor(config.model).expectedSize(config);
}

/** Human-readable name of a provider. */
export function providerLabel(provider: Provider): string {
  return PROVIDERS[provider].label;
}

/**
 * Generate images from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  validateGenerationConfig(config);
  return providerFor(config.model).generateImage(prompt, config, signal);
}

/**
 * Edit images using a text prompt.
 */
export async function editImage(
  prompt: string,
  inputImages: InputImage[],
  config: GenerationConfig,
  signal?: AbortSignal
): Promise<ImageResponse> {
  validateGenerationConfig(config, { inputImageCount: inputImages.length });
  return providerFor(config.model).editImage(prompt, inputImages, config, signal);
}

/**
 * Providers whose API key is present in the environment. The server refuses to
 * start with none, and names the enabled ones in its startup banner.
 */
export function enabledProviders(): Provider[] {
  const providers = Object.keys(PROVIDERS) as Provider[];
  return providers.filter((provider) => PROVIDERS[provider].hasApiKey());
}
