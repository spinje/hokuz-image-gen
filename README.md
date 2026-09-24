# hokuz-image-gen

An MCP (Model Context Protocol) server for generating and editing images using Google's Gemini image models via the [Interactions API](https://ai.google.dev/gemini-api/docs/image-generation) and OpenAI's GPT Image 2.5 models via the [Images API](https://developers.openai.com/api/docs/guides/images-vision). Both tools accept an optional `model` parameter; the default is `gemini-3.1-flash-image` (Nano Banana 2).

- [Features](#features)
- [Models](#models)
- [Performance & cost](#performance--cost)
- [Prerequisites](#prerequisites) · [Installation](#installation) · [Configuration](#configuration)
- [Usage](#usage)
- [Tools](#tools) — [`hokuz_generate_image`](#hokuz_generate_image) · [`hokuz_edit_image`](#hokuz_edit_image)
- [Troubleshooting](#troubleshooting)

## Features

- **Two providers, one tool set**: Google's Nano Banana (Gemini) models and OpenAI's GPT Image 2.5 models, selected with `model` (see the [model table](#models) below)
- **Text-to-Image Generation**: Create images from detailed text prompts
- **Image Editing**: Modify existing images with natural language instructions
- **Style Transfer**: Apply artistic styles from reference images
- **Multi-Image Composition**: Combine up to 14 images (Gemini) or 16 (OpenAI) into new compositions
- **High Resolution**: Up to 4K output (model-dependent)
- **PNG, WebP and transparent backgrounds**: OpenAI models produce `jpeg`, `png` or `webp`, with an optional transparent background (png/webp only)
- **Cost reporting**: results report the pixel size of each image and an estimated cost — Google's per-image price on Gemini models, the measured token counts on OpenAI models
- **Model-aware validation**: Unsupported combinations of model, resolution, aspect ratio and provider-only option are rejected before any API call — no silent downgrades

## Models

Select a model with the optional `model` parameter on either tool. The default is `gemini-3.1-flash-image`. Gemini models output **JPEG only**; OpenAI models output **JPEG, PNG or WebP**. All five share the same tool interface — capability differences are validated before any API call.

| Model ID | Provider | Name | Best for | Resolutions | Extreme aspect ratios | Speed¹ | Cost²/image |
|----------|----------|------|----------|-------------|-----------------------|--------|-------------|
| `gemini-3.1-flash-image` (default) | Google | Nano Banana 2 | Balanced generalist | `0.5K`, `1K`, `2K`, `4K` | Yes (`1:4`, `4:1`, `1:8`, `8:1`) | ~11 s | ~$0.07 (1K) |
| `gemini-3.1-flash-lite-image` | Google | Nano Banana 2 Lite | Cheapest / fastest | `1K` only | No | ~5 s | ~$0.034 |
| `gemini-3-pro-image` | Google | Nano Banana Pro | Highest quality | `1K`, `2K`, `4K` | No | ~17 s | ~$0.13 (1K) |
| `gpt-image-2.5-flare` | OpenAI | GPT Image 2.5 Flare | Text rendering, prompt adherence | `1K`, `2K` | No | ~14 s (medium) | set by `quality` |
| `gpt-image-2.5-sunburst` | OpenAI | GPT Image 2.5 Sunburst | Text-heavy posters, branding, faithful edits | `1K`, `2K` | No | ~18 s (medium) | set by `quality` |

OpenAI models take `quality` and `transparent_background` instead of `temperature`, and their requested pixel size is derived from `aspect_ratio` + `resolution` (`1K` ≈ 1 megapixel, `2K` ≈ 4), with each edge rounded to a multiple of 16. Aspect ratios are targets: OpenAI rounding and Gemini output can produce different file ratios; see [Output sizes](#output-sizes). Gemini models take `temperature` and reject the OpenAI-only options; the reverse also holds. Input images: Gemini takes up to 14 at 7 MB each (jpeg/png/webp/gif/heic/heif), OpenAI up to 16 at 50 MB each (jpeg/png/webp only).

## Output sizes

The pixel size a call is expected to deliver is published before the call (in the `aspect_ratio` field description) and echoed after it (`settings.expected_size`). Both come from one function, `expectedSize` in `src/providers/`:

| Ratio | Gemini 1K (measured) | OpenAI 1K (exact) |
|-------|----------------------|-------------------|
| `1:1` | 1024x1024 | 1024x1024 |
| `2:3` | 848x1264 | 832x1248 |
| `3:2` | 1264x848 | 1248x832 |
| `3:4` | 896x1200 | 880x1184 |
| `4:3` | 1200x896 | 1184x880 |
| `4:5` | 928x1152 | 912x1152 |
| `5:4` | 1152x928 | 1152x912 |
| `9:16` | 768x1376 | 768x1360 |
| `16:9` | 1376x768 | 1360x768 |
| `21:9` | 1584x672 | 1568x672 |
| `1:4` | 512x2064 | _n/a_ |
| `4:1` | 2064x512 | _n/a_ |
| `1:8` | 352x2928 | _n/a_ |
| `8:1` | 2928x352 | _n/a_ |

- **OpenAI** sizes are what the server sends as `size`: 1K ≈ 1 megapixel, 2K ≈ 4, each edge rounded to a multiple of 16 (so 2K is close to, not exactly, twice 1K: 16:9 at 2K is 2736x1536).
- **Gemini** sizes are chosen by Google, which publishes no table; these were measured with live calls on 2026-09-24 (all ratios on Flash; spot checks found the same grid on Lite and Pro). 2K is exactly twice 1K (verified on Flash and Pro). 0.5K and 4K were not measured, so no size is published and `settings.expected_size` is absent there (the ratio is still applied).
- `aspect_ratio: "auto"` on an edit has no expected size.

Neither provider's grid matches every ratio exactly (1:8 at 1K is 352x2928, about 1:8.32). Each saved image reports `aspect_error_pct`, the signed percentage by which its delivered ratio misses the requested one; resize or crop when an exact ratio matters.

## Performance & cost

**Speed** (¹): approximate wall-clock time for a single **1K** image measured through this server. Latency scales with resolution (4K is noticeably slower) and varies with prompt and API load. `num_images > 1` runs that many **separate** requests, so time and cost scale linearly (e.g. `num_images: 4` ≈ 4× a single image).

**Cost** (²): approximate per-image prices (Standard tier) at time of writing — **verify current rates on the [Google pricing page](https://ai.google.dev/gemini-api/docs/pricing)**, they change often. Higher resolutions cost more. A cell marked _n/a_ means that model does **not support** that resolution, so the request is rejected before any API call (there is no such combination to price):

| Resolution | Nano Banana 2 Lite | Nano Banana 2 (Flash) | Nano Banana Pro |
|------------|--------------------|-----------------------|-----------------|
| `0.5K`     | _n/a_              | ~$0.045               | _n/a_           |
| `1K`       | ~$0.034            | ~$0.067               | ~$0.134         |
| `2K`       | _n/a_              | ~$0.101               | ~$0.134         |
| `4K`       | _n/a_              | ~$0.151               | ~$0.240         |

These are the prices the server estimates a Gemini result's cost with (`GEMINI_PRICE_PER_IMAGE_USD` in `src/constants.ts`), charged per image for the requested resolution.

**GPT Image 2.5 cost by quality** (1K, estimated; Flare and Sunburst bill identically):

| `quality` | Cost²/image | Flare speed¹ | Sunburst speed¹ |
|-----------|-------------|--------------|-----------------|
| `low`     | ~$0.006     | ~10 s        | ~16 s           |
| `medium`  | ~$0.013     | ~14 s        | ~18 s           |
| `high`    | ~$0.05      | ~18 s        | ~30 s           |
| `xhigh`   | ~$0.09      | ~27 s        | ~47 s           |
| `max`     | ~$0.21      | ~46 s        | ~85 s           |

`2K` roughly doubles the output-token cost of the same quality. Reference images on an edit cost about $0.01 each (~1000 input tokens per 1K image), versus a fraction of a cent on Gemini — for compositions with 4+ reference images prefer `gemini-3.1-flash-image`. OpenAI prices are token-based ($5 / $8 / $30 per million text-input / image-input / image-output tokens, **verify on the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing)**). Results report an estimated cost: from the measured token counts on OpenAI models, from Google's per-image price for the requested resolution on Gemini models (input and text tokens, a fraction of a cent, are not included).

**Rule of thumb:** default to **Flash** for everyday work; drop to **Lite** for drafts, thumbnails, and high-volume batches where speed and cost matter most; reach for **Pro** for hero shots, photorealism, and cinematic lighting where the extra time and cost are justified. Reach for **Flare** or **Sunburst** when the image carries text or must match a precise composition, and raise `quality` only as far as the result needs.

## Prerequisites

- Node.js 22 or higher
- At least one provider API key:
  - Google AI Studio, for the `gemini-*` models ([get one here](https://aistudio.google.com/))
  - OpenAI, for the `gpt-image-*` models ([get one here](https://platform.openai.com/api-keys))

## Installation

```bash
# Clone the repository
git clone https://github.com/spinje/hokuz-image-gen.git
cd hokuz-image-gen

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Set at least one provider API key as an environment variable:

```bash
export GEMINI_API_KEY="your-api-key-here"
# or, for compatibility
export GOOGLE_API_KEY="your-api-key-here"

export OPENAI_API_KEY="your-api-key-here"
```

The server refuses to start with no key at all. With only one key it still starts and serves both tools; a model belonging to the missing provider fails with an error naming the variable to set.

## Usage

### Claude Code

Add the server to Claude Code as a local stdio MCP server:

```bash
export GEMINI_API_KEY="your-api-key-here"
export OPENAI_API_KEY="your-api-key-here"

claude mcp add hokuz-image-gen \
  --scope local \
  --transport stdio \
  --env GEMINI_API_KEY="$GEMINI_API_KEY" \
  --env OPENAI_API_KEY="$OPENAI_API_KEY" \
  -- node /absolute/path/to/hokuz-image-gen/dist/index.js

claude mcp list
```

`--scope local` stores the MCP server in your private Claude Code configuration for the current project, not in this repository. After starting Claude Code, run `/mcp` to verify that `hokuz-image-gen` is connected.

### Claude Desktop

Add to your Claude Desktop configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "hokuz-image-gen": {
      "command": "node",
      "args": ["/absolute/path/to/hokuz-image-gen/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here",
        "OPENAI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Running Directly

```bash
npm start
```

The server runs via stdio transport. You usually do not need to run this command yourself when using Claude Code or Claude Desktop because the MCP client starts the server process from its configuration. It is useful for local development, smoke testing, or wiring the server into another MCP-compatible client.

## Tools

Both tool descriptions and the server instructions are kept within Claude Code's 2,048-character limit (a test enforces it), so rules about a single parameter live in that parameter's schema description, which clients receive in full. The server instructions, which Claude Code shows before a tool's schema is loaded, point callers at URL inputs and at the `settings` a result reports.

For callers using `functions.exec` and `ALL_TOOLS`, the optional [discovery guide](guides/caller-discovery.md) shows how to inspect the needed tool without printing overlapping metadata. Give the guide to the caller explicitly; installing this server does not apply it automatically.

### hokuz_generate_image

Generate images from text prompts.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description of the image to generate |
| `output_path` | string | Yes | - | File path to save the image (directory or full path). Its extension selects `output_format` when that is omitted, and the saved file's extension always matches the format. An existing file is never overwritten: `-2`, `-3`, … is appended. Missing parent directories are created |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"1:1"` | Target ratio; the delivered pixel size can differ from it by a few percent (the description lists the expected size per ratio; see [Output sizes](#output-sizes)). `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`; plus `1:4`, `4:1`, `1:8`, `8:1` (flash only). OpenAI models accept the ten base ratios. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio` with each edge rounded to a multiple of 16) |
| `output_format` | string | No | the `output_path` extension, else `jpeg` | `jpeg` (all models), `png` or `webp` (OpenAI models only). When omitted, a `.jpg`/`.jpeg`/`.png`/`.webp` extension on `output_path` selects the format; the saved file's extension always matches the format |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
| `transparent_background` | boolean | No | - | `true` requires an OpenAI model and `png` or `webp`; `false` is accepted by every model |
| `include_preview` | boolean | No | `false` | Include a bounded derived JPEG preview and original-pixel alpha measurements; requires MCP image display support. A preview failure adds `preview_warning` without failing the call (see [Optional inline previews](#optional-inline-previews)) |
| `num_images` | number | No | `1` | Number of images (1-4). Each is a separate request, made one after another, so time and cost scale linearly; each is saved before the next is requested, and a failure stops the batch |
| `temperature` | number | No | `1.0` (Gemini models) | **Gemini models only.** Creativity (0.0-2.0). Rejected on OpenAI models |

**Examples:**

```
prompt: "A serene mountain lake at sunset with snow-capped peaks"
output_path: ~/images/

prompt: "Professional headshot of a confident businesswoman, studio lighting"
output_path: ~/images/headshot.jpg
aspect_ratio: 3:4
```

**Returns** (both tools): `{ status, images: [{ path, format, width?, height?, aspect_error_pct?, preview?, preview_warning? }], settings?, issue?: { code, message, next_step }, description?, usage? }`.

- `complete`: every requested image was saved.
- `partial`: some images were saved; keep them and read `issue` before requesting only the shortfall.
- `failed`: no image was saved. This does **not** mean generation never happened or that no charge was incurred.

`issue` explains what prevented completion and what to do next. The text response includes the same saved paths and recovery advice. Each provider response is saved before requesting another image; a save failure stops further generation. Unsaved images cannot be retrieved later through this tool. Generation requests are never automatically retried, and an interrupted request may have completed at the provider. SDK argument-validation errors remain standard MCP errors identifying the invalid fields.

`images[].path` is authoritative. `width`/`height` describe the saved image when available and can differ from the requested aspect ratio by a few percent (1:8 at 1K gives 352x2928, about 1:8.32); preview dimensions are separate. `aspect_error_pct` (added in 2.2.0) is that difference: (delivered width/height ÷ requested ratio − 1) × 100, signed and rounded to 2 decimals, so 352x2928 for 1:8 is `-3.83` (narrower than requested). It is present only when an explicit ratio was requested and the image's size is known. A preview failure leaves the original usable and adds `preview_warning`.

`settings` (added in 2.1.0) reports the settings the call's requests were built with; cite it rather than the call's arguments: `{ model, aspect_ratio, resolution?, expected_size?, output_format, quality?, temperature?, transparent_background? }`. `expected_size` (added in 2.2.0) is the `WxH` from [Output sizes](#output-sizes), absent when no size is known in advance (`auto`, or Gemini 0.5K/4K, where no measured size is published). Provider defaults are filled in, so an omitted `quality` on an OpenAI model is reported as `medium` and an omitted `temperature` on a Gemini model as `1`. `quality` and `transparent_background` appear only for OpenAI models, `temperature` only for Gemini models. `aspect_ratio` is the requested target (`auto` for an edit that left it to the model); `resolution` is absent only when an OpenAI edit with `auto` let the provider choose the size. `settings` is present whenever generation started, including partial and failed results (even when no request completed), and absent when a call was rejected before that. The text response carries the same facts on one line, for example `Settings: gpt-image-2.5-flare, aspect_ratio 16:9 (target; delivered pixel size per image above), 1K, expected_size 1360x768, png, quality medium, transparent_background true`. Each saved image's own text line gives its delivered size, followed by its `aspect_error_pct` when that is beyond ±0.5% and by the expected size when delivery differs from it, for example `~/img/poster.jpg (1264x848; -0.63% vs 3:2; expected 1248x832)`. An image whose size is unknown reads `~/img/poster.jpg (size unknown; inspect the file)`.

`usage` contains optional `input_tokens`/`output_tokens`, `estimated_cost_usd`, `cost_basis`, `requests_completed`, and `requests_reported`. Estimates cover only reported responses, including responses without usable images or whose images could not be saved. Unreported charges may apply, including for failed or interrupted requests. `cost_basis` is `tokens` for OpenAI or `per_image` for Gemini. Missing token counts are omitted, not zero. `requests_reported` below `requests_completed` means the estimate covers only some completed requests.

Version 2 replaces `success`, `warning`, `error`, `error_type`, and `retryable` with `status` and `issue`, and renames `usage.requests_succeeded` to `usage.requests_completed` to include responses without usable images. MCP `isError` is true for failed delivery; partial delivery retains usable images and an issue.

### hokuz_edit_image

Edit existing images using text instructions. Generative edits on either provider can change composition and details; original framing and pixel-identical preservation are not guaranteed. Inspect the saved result for changes beyond the requested edit.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Editing instruction |
| `image_paths` | string[] | Yes | - | Array of local image paths or public HTTP(S) URLs (pass a URL directly; no need to download it first), in prompt order ("first image" / "second image"). Gemini models: up to 14 images, 7 MB each, jpeg/png/webp/gif/heic/heif. OpenAI models: up to 16 images, 50 MB each, jpeg/png/webp only. Combined inputs must fit 128 MiB. Count, type and size are checked before any provider call. Each reference costs ~$0.01 on OpenAI and a fraction of a cent on Gemini, so prefer `gemini-3.1-flash-image` for 4+ references |
| `output_path` | string | Yes | - | File path to save result (directory or full path). Its extension selects `output_format` when that is omitted, and the saved file's extension always matches the format. An existing file is never overwritten: `-2`, `-3`, … is appended. Missing parent directories are created |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"auto"` | `auto` or any generate target ratio (expected sizes as in [Output sizes](#output-sizes); none for `auto`). Gemini `auto` omits the ratio and still applies `resolution`; OpenAI `auto` lets the provider choose the size and rejects explicit `resolution`. Auto does not guarantee original framing. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `1K` (Gemini, or OpenAI with an explicit ratio) | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio` with each edge rounded to a multiple of 16). No schema default here: on an OpenAI model it needs an explicit `aspect_ratio`, and `auto` plus a resolution is rejected |
| `output_format` | string | No | the `output_path` extension, else `jpeg` | `jpeg` (all models), `png` or `webp` (OpenAI models only). When omitted, a `.jpg`/`.jpeg`/`.png`/`.webp` extension on `output_path` selects the format; the saved file's extension always matches the format |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
| `transparent_background` | boolean | No | - | `true` requires an OpenAI model and `png` or `webp`; `false` is accepted by every model |
| `include_preview` | boolean | No | `false` | Include a bounded derived JPEG preview and original-pixel alpha measurements; requires MCP image display support. A preview failure adds `preview_warning` without failing the call (see [Optional inline previews](#optional-inline-previews)) |
| `num_images` | number | No | `1` | Number of variations (1-4). Each is a separate request, made one after another, so time and cost scale linearly; each is saved before the next is requested, and a failure stops the batch |
| `temperature` | number | No | `1.0` (Gemini models) | **Gemini models only.** Creativity (0.0-2.0). Rejected on OpenAI models |

**Examples:**

```
prompt: "Remove the background and replace with pure white"
image_paths: ["~/photos/portrait.jpg"]
output_path: ~/edited/portrait-nobg.jpg

prompt: "Apply the artistic style of the second image to the first"
image_paths: ["~/photos/landscape.jpg", "~/styles/vangogh.jpg"]
output_path: ~/edited/

prompt: "Colorize this black and white photograph with realistic colors"
image_paths: ["~/old-photos/grandma-1950.jpg"]
output_path: ~/restored/
```

## Local resource and file controls

Optionally set `HOKUZ_OUTPUT_ROOT` to an existing absolute directory. Relative output paths then start in that directory; absolute paths, traversal and symlink targets outside it are rejected before provider work and checked again when saving. An empty or invalid root is rejected. Without this setting, output paths retain their existing behavior. `~` and `~/` expand to the current user's home (using the account home if `HOME` is unset); `~otheruser` is not expanded.

The output-root setting controls this MCP's writes. It is not an OS sandbox for other tools or a defense against a separate local process replacing directories between checks. Untrusted participant sessions still need filesystem permissions/sandboxing that cover all their tools.

Edit reference images have a combined **128 MiB input-byte limit**, in addition to each model's per-image limits. Oversized combinations are rejected before contacting the provider; images are never silently resized. Local files must be regular files, with size checked before opening and actual reads bounded in case a file grows. Remote declared lengths and streamed bytes are checked against the remaining budget. This is an input budget, not a total process-memory ceiling.

Each server process admits one generate/edit call at a time, including input loading, saving and previews. Overlapping calls return `SERVER_BUSY` before loading inputs or contacting a provider; wait for the active call to finish before retrying. Calls are not queued. This limit is shared across the two tools, but does not limit how many server processes a client starts.

Saved filenames are claimed with exclusive creation, including when different processes write to the same directory. Collisions try the next suffix without repeating the provider request, with a maximum of 10,000 candidate names. Other write failures stop immediately.

Client cancellation is forwarded to provider requests and input reads, and stops subsequent image requests and previews. Already-returned provider images are still saved. Cancellation does not guarantee that the provider has stopped or refunded an in-flight request. Preview processing checks cancellation between metadata, statistics, resizing and encoding stages. An already-running native stage must finish before the active-call slot is released; cancellation prevents subsequent stages but does not terminate native decoding. A cancellation issue advises against automatic retry.

Public HTTP(S) image URLs remain enabled by default. Every connection and redirect must resolve only to public addresses; loopback, private/link-local, reserved and translation/tunnel address ranges are rejected. The transport checks the addresses supplied directly to the socket, follows at most five redirects within the existing 30-second deadline, and closes rejected responses. It uses direct connections without a proxy and requests identity HTTP content encoding; servers that insist on encoded responses are rejected. Every request, including each redirect hop, sends `User-Agent: hokuz-image-gen/<version> (+https://github.com/spinje/hokuz-image-gen)`; some hosts, such as `upload.wikimedia.org`, refuse requests without one. For private-network sources, download the image separately and pass its local path.

## Optional inline previews

Set `include_preview: true` on either tool to inspect a reduced image in a client that supports MCP image content. The saved file remains the original provider bytes; its returned path, format, dimensions and cost are unchanged. Previews are derived JPEGs, never replacements for transparent originals. Nonopaque images appear twice, on white (left) and navy (right); opaque images appear once. Fine text, exact layouts and edge quality can still require opening the original.

`images[].preview` identifies the image block by its zero-based `content_index` and reports preview dimensions and original 8-bit alpha extrema. `has_channel` alone does not prove transparency: an opaque PNG can have an alpha channel. A minimum below 255 means some nonopaque pixels; 0 means at least one fully transparent pixel. No alpha channel is reported as effective opacity 255–255. These measurements do not establish a clean cutout or preservation of the reference.

The optional native `sharp` dependency is installed by default on supported platforms. An already-built server can still generate/edit images when optional dependencies are omitted. Building, typechecking or testing this TypeScript checkout requires `sharp` installed, so use the normal install for development. When the decoder is unavailable, requested previews carry a per-image `preview_warning`; inspect the already-saved original instead of repeating a paid call. The same nonfatal notice applies to decoding failures or preview limits. A top-level `issue` describes a delivery shortfall independently.

Preview processing accepts single-frame, 8-bit JPEG/PNG/WebP up to 32 MiB, 25 million pixels and 16,384 pixels on either edge. Each panel fits within 512×512 without upscaling or cropping; a two-panel result is at most 1024×512. Each preview is at most 200 KiB of JPEG (at most four images / 800 KiB before base64 encoding per call). Processing is sequential, with a three-second native timeout per output pipeline, excluding native queue time; original statistics and metadata are bounded by input size/pixels, not that timeout; it is not a total-call deadline. Original generation and saving are not subject to these preview limits. Preview payloads can add client image-token costs; no additional provider request is made.

For callers using `functions.exec`, forward image blocks to the image renderer; do not stringify the full result or print its base64 as text. Replace the illustrative tool name below with the discovered callable tool:

```javascript
const result = await tools.discovered_hokuz_tool({ ...args, include_preview: true });
for (const block of result.content) {
  if (block.type === "image") image(block);
  else if (block.type === "text") text(block.text);
}
```

Clients that cannot display MCP images should leave `include_preview` off and inspect the saved path with their own viewer.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile to dist/
npm run dev          # Development mode with auto-reload (tsx watch)
npm run clean        # Remove build artifacts

npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (zero warnings allowed)
npm test             # Vitest (no network; includes native image tests)
npm run check        # typecheck + lint + test — the gate CI runs on every pull request

npm run build && npm run smoke   # paid live check against both providers (~10 cents)
```

For the source layout and contributor guidance, see [CLAUDE.md](CLAUDE.md#project-structure).

## Troubleshooting

For partial or failed delivery, read `issue.message` and `issue.next_step`. Keep the files listed in `images`; another request creates new images and can incur additional charges.

- **Credentials or access:** the server operator must configure the selected provider's key and account access. Do not pass API keys in tool arguments.
- **Unsupported arguments:** use the accepted values named in the issue and the [Models](#models) table. Capability mismatches are rejected before generation.
- **No usable image:** inspect any returned model response. An empty image response alone does not establish a moderation block.
- **Input download or file failure:** correct the indicated path, permissions, format or size. A URL must serve a public image with an appropriate content-type; downloading it and passing a local image file is another option.
- **Unknown completion:** an interrupted request may have completed at the provider. There is no automatic retry or later retrieval through this tool.

## License

[MIT](LICENSE)
