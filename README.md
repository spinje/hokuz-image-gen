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

OpenAI models take `quality` and `transparent_background` instead of `temperature`, and their requested pixel size is derived from `aspect_ratio` + `resolution` (`1K` ≈ 1 megapixel, `2K` ≈ 4), with each edge rounded to a multiple of 16. Aspect ratios are targets: OpenAI rounding and Gemini output can produce different file ratios. For exact layouts, check returned `width`/`height` when available, or inspect the saved file. Gemini models take `temperature` and reject the OpenAI-only options; the reverse also holds. Input images: Gemini takes up to 14 at 7 MB each (jpeg/png/webp/gif/heic/heif), OpenAI up to 16 at 50 MB each (jpeg/png/webp only).

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

For callers using `functions.exec` and `ALL_TOOLS`, the optional [discovery guide](guides/caller-discovery.md) shows how to inspect the needed tool without printing overlapping metadata. Give the guide to the caller explicitly; installing this server does not apply it automatically.

### hokuz_generate_image

Generate images from text prompts.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description of the image to generate |
| `output_path` | string | Yes | - | File path to save the image (directory or full path). Its extension selects `output_format` when that is omitted, and the saved file's extension always matches the format. An existing file is never overwritten: `-2`, `-3`, … is appended |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"1:1"` | Target ratio; actual pixel dimensions can differ. `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`; plus `1:4`, `4:1`, `1:8`, `8:1` (flash only). OpenAI models accept the ten base ratios. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio` with each edge rounded to a multiple of 16) |
| `output_format` | string | No | the `output_path` extension, else `jpeg` | `jpeg` (all models), `png` or `webp` (OpenAI models only). When omitted, a `.jpg`/`.jpeg`/`.png`/`.webp` extension on `output_path` selects the format; the saved file's extension always matches the format |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
| `transparent_background` | boolean | No | - | `true` requires an OpenAI model and `png` or `webp`; `false` is accepted by every model |
| `include_preview` | boolean | No | `false` | Include a bounded derived JPEG preview and original-pixel alpha measurements; requires MCP image display support |
| `num_images` | number | No | `1` | Number of images (1-4). Produced via repeated requests |
| `temperature` | number | No | `1.0` (Gemini models) | **Gemini models only.** Creativity (0.0-2.0). Rejected on OpenAI models |

**Examples:**

```
prompt: "A serene mountain lake at sunset with snow-capped peaks"
output_path: ~/images/

prompt: "Professional headshot of a confident businesswoman, studio lighting"
output_path: ~/images/headshot.jpg
aspect_ratio: 3:4
```

**Returns** (both tools): `{ status, images: [{ path, format, width?, height?, preview?, preview_warning? }], issue?: { code, message, next_step }, description?, usage? }`.

- `complete`: every requested image was saved.
- `partial`: some images were saved; keep them and read `issue` before requesting only the shortfall.
- `failed`: no image was saved. This does **not** mean generation never happened or that no charge was incurred.

`issue` explains what prevented completion and what to do next. The text response includes the same saved paths and recovery advice. Each provider response is saved before requesting another image; a save failure stops further generation. Unsaved images cannot be retrieved later through this tool. Generation requests are never automatically retried, and an interrupted request may have completed at the provider. SDK argument-validation errors remain standard MCP errors identifying the invalid fields.

`images[].path` is authoritative. `width`/`height` describe the saved image when available; preview dimensions are separate. A preview failure leaves the original usable and adds `preview_warning`.

`usage` contains optional `input_tokens`/`output_tokens`, `estimated_cost_usd`, `cost_basis`, `requests_succeeded`, and `requests_reported`. Estimates cover only reported responses, including images returned but not saved; charges for failed or interrupted requests are not included. `cost_basis` is `tokens` for OpenAI or `per_image` for Gemini. Missing token counts are omitted, not zero. `requests_reported` below `requests_succeeded` means the estimate covers only some requests that returned images.

Version 2 replaces `success`, `warning`, `error`, `error_type`, and `retryable` with `status` and `issue`. MCP `isError` is true for failed delivery; partial delivery retains usable images and an issue.

### hokuz_edit_image

Edit existing images using text instructions. Generative edits on either provider can change composition and details; original framing and pixel-identical preservation are not guaranteed. Inspect the saved result for changes beyond the requested edit.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Editing instruction |
| `image_paths` | string[] | Yes | - | Array of local image paths or public HTTP(S) URLs, in prompt order ("first image" / "second image"). Gemini models: up to 14 images, 7 MB each, jpeg/png/webp/gif/heic/heif. OpenAI models: up to 16 images, 50 MB each, jpeg/png/webp only. Combined inputs must fit 128 MiB. Count, type and size are checked before any provider call |
| `output_path` | string | Yes | - | File path to save result (directory or full path). Its extension selects `output_format` when that is omitted, and the saved file's extension always matches the format. An existing file is never overwritten: `-2`, `-3`, … is appended |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"auto"` | `auto` or any generate target ratio. Gemini `auto` omits the ratio and still applies `resolution`; OpenAI `auto` lets the provider choose the size and rejects explicit `resolution`. Auto does not guarantee original framing. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `1K` (Gemini, or OpenAI with an explicit ratio) | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio` with each edge rounded to a multiple of 16). No schema default here: on an OpenAI model it needs an explicit `aspect_ratio`, and `auto` plus a resolution is rejected |
| `output_format` | string | No | the `output_path` extension, else `jpeg` | `jpeg` (all models), `png` or `webp` (OpenAI models only). When omitted, a `.jpg`/`.jpeg`/`.png`/`.webp` extension on `output_path` selects the format; the saved file's extension always matches the format |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
| `transparent_background` | boolean | No | - | `true` requires an OpenAI model and `png` or `webp`; `false` is accepted by every model |
| `include_preview` | boolean | No | `false` | Include a bounded derived JPEG preview and original-pixel alpha measurements; requires MCP image display support |
| `num_images` | number | No | `1` | Number of variations (1-4). Produced via repeated requests |
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

Public HTTP(S) image URLs remain enabled by default. Every connection and redirect must resolve only to public addresses; loopback, private/link-local, reserved and translation/tunnel address ranges are rejected. The transport checks the addresses supplied directly to the socket, follows at most five redirects within the existing 30-second deadline, and closes rejected responses. It uses direct connections without a proxy and requests identity HTTP content encoding; servers that insist on encoded responses are rejected. For private-network sources, download the image separately and pass its local path.

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

### "No provider API key found" (the server will not start)
Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and/or `OPENAI_API_KEY` in your environment or MCP client configuration. At least one is required.

### "GEMINI_API_KEY is not set" / "OPENAI_API_KEY is not set, so '…' cannot be used"
The server started with the other provider's key. Either set the named variable, or choose a model from the provider whose key is present.

### "Model … does not support resolution/aspect ratio …"
The requested option is not valid for the chosen model, and the request is rejected before any API call. Check the [Models](#models) table — for example, Lite is `1K` only, Pro does not support the extreme aspect ratios, only Flash supports `0.5K` and `1:4`/`4:1`/`1:8`/`8:1`, and OpenAI models accept `1K`/`2K` and the ten base ratios. Either switch models or pick a supported value.

### "Model … does not support output_format 'png'"
Gemini models produce JPEG only. Use `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` for `png`/`webp`, or ask for `jpeg`. An `output_path` ending in `.png` or `.webp` asks for that format just as `output_format` does, so `~/images/logo.png` on a Gemini model is rejected rather than saved as a JPEG.

### "transparent_background requires output_format 'png' or 'webp'"
JPEG has no alpha channel, and the OpenAI API rejects that combination outright. Set `output_format` to `png` or `webp`, or drop `transparent_background`.

### "Model … does not support transparent_background"
Transparency is an OpenAI-only option. Use `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` with `output_format` `png` or `webp`.

### "Model … accepts at most 14 input images"
Gemini models take 14 reference images, OpenAI models 16. Remove images, or switch to an OpenAI model. The count is checked before any image is read.

### "Model … does not accept image/gif input"
OpenAI models accept jpeg, png and webp only; GIF and HEIC are rejected before the API call. Convert the image, or use a Gemini model, which accepts both.

### "Model … does not accept 'quality'" / "does not accept 'temperature'"
`quality` is OpenAI-only and `temperature` is Gemini-only. Omit the option, or switch to a model of the other provider. Neither has a schema default; each provider applies its own default when its option is omitted.

### "Model … cannot apply resolution … when aspect_ratio is 'auto'"
On OpenAI models the pixel size is derived from `aspect_ratio`, and `auto` (the `hokuz_edit_image` default) hands the choice to the provider, so a `resolution` could not be honoured. Set an `aspect_ratio` to request a target shape and resolution, or omit `resolution`. Gemini models apply `resolution` whatever the ratio.

### "OpenAI denied access (403)"
GPT Image models may require organisation verification in the [OpenAI dashboard](https://platform.openai.com/settings/organization/general). Until that clears, use a Gemini model.

### "OpenAI's content moderation blocked this request"
The prompt or an input image tripped OpenAI's moderation. The message names the stage and categories; rephrase the prompt or change the inputs.

### "No images were generated" / "Gemini's safety filters blocked this request"
The server currently classifies both a Gemini response with no image and an explicit safety rejection as `CONTENT_BLOCKED`. A missing image alone does not establish that moderation caused it; inspect the returned message.

### "Gemini rejected the API key"
Google answers an invalid key with a 400 rather than a 401. Check `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the MCP server's environment — get a key at [AI Studio](https://aistudio.google.com/) — or use an OpenAI model.

### "Gemini denied the request (403)"
The request was denied: check the project's billing and API enablement in the Google Cloud console, or use an OpenAI model.

### "Gemini reports model '…' was not found"
A 404 means either the model ID has been retired or the requested resolution is not offered for it. Verify the ID against the [models list](https://ai.google.dev/gemini-api/docs/models), try another Gemini model, or use an OpenAI model.

### "Rate limit exceeded"
Wait before retrying. Limits depend on the provider, model and account tier.

### "Image file not found"
Verify the image path is correct. Use absolute paths or paths relative to home (`~/`).

### "Image at … is …MB, above the …MB limit for '…'"
Each input image must fit the selected model's limit: 7 MB on Gemini models, 50 MB on OpenAI models. Combined references must also fit the 128 MiB local input budget. Declared sizes are checked before buffering, and actual local/remote reads are capped too. Resize the image, or use an OpenAI model.

### "Cannot determine the image type of …"
Local inputs are typed by their file extension, URLs by the response's `content-type` header. When neither says what the file is, the request stops rather than guessing — a guess would hide exactly the files the format check exists to catch. Rename the file to its real extension (`.jpg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif`), or, for a URL that serves no `content-type`, download the image and pass a local path.

### "Could not fetch image from …"
The server could not read the URL: a non-OK status, a connection failure, or no response within 30 seconds. Check the URL, or download the image and pass a local path.

## License

[MIT](LICENSE)
