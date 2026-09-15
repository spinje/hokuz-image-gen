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
- **Multi-Image Composition**: Combine up to 14 images into new compositions
- **High Resolution**: Up to 4K output (model-dependent)
- **Cost reporting**: OpenAI results include the token counts used and a cost estimated from them
- **Model-aware validation**: Unsupported combinations of model, resolution, aspect ratio and provider-only option are rejected before any API call — no silent downgrades

## Models

Select a model with the optional `model` parameter on either tool. The default is `gemini-3.1-flash-image`. All five output **JPEG only** and share the same tool interface — capability differences are validated before any API call.

| Model ID | Provider | Name | Best for | Resolutions | Extreme aspect ratios | Speed¹ | Cost²/image |
|----------|----------|------|----------|-------------|-----------------------|--------|-------------|
| `gemini-3.1-flash-image` (default) | Google | Nano Banana 2 | Balanced generalist | `0.5K`, `1K`, `2K`, `4K` | Yes (`1:4`, `4:1`, `1:8`, `8:1`) | ~11 s | ~$0.07 (1K) |
| `gemini-3.1-flash-lite-image` | Google | Nano Banana 2 Lite | Cheapest / fastest | `1K` only | No | ~5 s | ~$0.034 |
| `gemini-3-pro-image` | Google | Nano Banana Pro | Highest quality | `1K`, `2K`, `4K` | No | ~17 s | ~$0.13 (1K) |
| `gpt-image-2.5-flare` | OpenAI | GPT Image 2.5 Flare | Text rendering, prompt adherence | `1K`, `2K` | No | ~14 s (medium) | set by `quality` |
| `gpt-image-2.5-sunburst` | OpenAI | GPT Image 2.5 Sunburst | Text-heavy posters, branding, faithful edits | `1K`, `2K` | No | ~18 s (medium) | set by `quality` |

OpenAI models take `quality` instead of `temperature`, and their pixel size is derived from `aspect_ratio` + `resolution` (`1K` ≈ 1 megapixel, `2K` ≈ 4) and reported back as `width`/`height`. Gemini models take `temperature` and reject `quality`; the reverse also holds.

## Performance & cost

**Speed** (¹): approximate wall-clock time for a single **1K** image measured through this server. Latency scales with resolution (4K is noticeably slower) and varies with prompt and API load. `num_images > 1` runs that many **separate** requests, so time and cost scale linearly (e.g. `num_images: 4` ≈ 4× a single image).

**Cost** (²): approximate per-image prices (Standard tier) at time of writing — **verify current rates on the [Google pricing page](https://ai.google.dev/gemini-api/docs/pricing)**, they change often. Higher resolutions cost more. A cell marked _n/a_ means that model does **not support** that resolution, so the request is rejected before any API call (there is no such combination to price):

| Resolution | Nano Banana 2 Lite | Nano Banana 2 (Flash) | Nano Banana Pro |
|------------|--------------------|-----------------------|-----------------|
| `0.5K`     | _n/a_              | ~$0.045               | _n/a_           |
| `1K`       | ~$0.034            | ~$0.067               | ~$0.134         |
| `2K`       | _n/a_              | ~$0.101               | ~$0.134         |
| `4K`       | _n/a_              | ~$0.151               | ~$0.240         |

**GPT Image 2.5 cost by quality** (1K, estimated; Flare and Sunburst bill identically):

| `quality` | Cost²/image | Flare speed¹ | Sunburst speed¹ |
|-----------|-------------|--------------|-----------------|
| `low`     | ~$0.006     | ~10 s        | ~16 s           |
| `medium`  | ~$0.013     | ~14 s        | ~18 s           |
| `high`    | ~$0.05      | ~18 s        | ~30 s           |
| `xhigh`   | ~$0.09      | ~27 s        | ~47 s           |
| `max`     | ~$0.21      | ~46 s        | ~85 s           |

`2K` roughly doubles the output-token cost of the same quality. Reference images on an edit cost about $0.01 each (~1000 input tokens per 1K image), versus a fraction of a cent on Gemini — for compositions with 4+ reference images prefer `gemini-3.1-flash-image`. OpenAI prices are token-based ($5 / $8 / $30 per million text-input / image-input / image-output tokens, **verify on the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing)**); every OpenAI result reports the measured token counts and the cost estimated from them.

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

### hokuz_generate_image

Generate images from text prompts.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description of the image to generate |
| `output_path` | string | Yes | - | File path to save the image (directory or full path). Any extension is normalized to `.jpg` |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"1:1"` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`; plus `1:4`, `4:1`, `1:8`, `8:1` (flash only). OpenAI models accept the ten base ratios. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio`) |
| `output_format` | string | No | `"jpeg"` | Only `jpeg` is supported (every model outputs JPEG) |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
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

**Returns** (both tools): `{ success, images: [{ path, format, width?, height? }], description?, usage?, warning?, error? }`. `width`/`height` are set only by providers that report the pixel size (OpenAI). `usage` — `{ input_tokens, output_tokens, estimated_cost_usd }`, summed over the requests made — is present for OpenAI results only, and its cost is estimated from the token counts, not billed. `warning` is set when fewer images than requested were produced and carries the failing request's error.

### hokuz_edit_image

Edit existing images using text instructions.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Editing instruction |
| `image_paths` | string[] | Yes | - | Array of image paths or URLs (1-14 images, 7 MB each), in prompt order ("first image" / "second image") |
| `output_path` | string | Yes | - | File path to save result (directory or full path). Any extension is normalized to `.jpg` |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `aspect_ratio` | string | No | `"auto"` | `auto` (preserve original) or any generate ratio. On OpenAI models `auto` lets the provider choose the size, and `resolution` is not applied. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`; OpenAI models are `1K`/`2K`, where `1K` ≈ 1 megapixel and `2K` ≈ 4, derived from `aspect_ratio`) |
| `output_format` | string | No | `"jpeg"` | Only `jpeg` is supported (every model outputs JPEG) |
| `quality` | string | No | `"medium"` (OpenAI models) | **OpenAI models only.** `low`, `medium`, `high`, `xhigh`, `max` — see the [cost table](#performance--cost). Rejected on Gemini models |
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

## Use Cases

### Basic Generation
- Product mockups and visualizations
- Social media graphics
- Concept art and illustrations

### Image Editing
- Background removal/replacement
- Color correction and enhancement
- Object addition/removal

### Style Transfer
- Apply artistic styles to photographs
- Create consistent visual branding
- Transform images into different art styles

### Text-Heavy and Branding Work
- Posters, packaging mockups and social cards whose text must read correctly — `gpt-image-2.5-sunburst` at `quality: "high"`
- Edits where approved details (faces, logos, layout) must survive unchanged

### Multi-Image Composition
- Combine product shots into catalogs
- Create composite scenes
- Maintain character consistency across images

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile to dist/
npm run dev          # Development mode with auto-reload (tsx watch)
npm run clean        # Remove build artifacts

npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (zero warnings allowed)
npm test             # Vitest (no network; ~0.5 s)
npm run check        # typecheck + lint + test — the gate CI runs on every pull request
```

## Project Structure

```
.
├── src/
│   ├── index.ts              # Entry point (stdio startup)
│   ├── server.ts             # createServer(): registers tools
│   ├── constants.ts          # Models, capability registry, limits, defaults
│   ├── types.ts              # TypeScript types and McpError
│   ├── schemas/
│   │   ├── generate.ts       # Generate tool schema
│   │   └── edit.ts           # Edit tool schema
│   ├── providers/
│   │   ├── index.ts          # Validation + dispatch on the registry's provider
│   │   ├── gemini.ts         # Gemini Interactions API client
│   │   ├── openai.ts         # OpenAI Images API client
│   │   └── __tests__/
│   ├── services/
│   │   ├── file-utils.ts     # File operations
│   │   └── __tests__/
│   ├── tools/
│   │   ├── generate-image.ts # Generate tool
│   │   ├── edit-image.ts     # Edit tool
│   │   └── __tests__/
│   └── __tests__/            # Server contract tests + in-memory MCP harness
├── .github/workflows/ci.yml  # PR gate: build, typecheck, lint, test
├── dist/                     # Compiled output (generated)
├── eslint.config.js
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### "No provider API key found" (the server will not start)
Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and/or `OPENAI_API_KEY` in your environment or MCP client configuration. At least one is required.

### "GEMINI_API_KEY is not set" / "OPENAI_API_KEY is not set, so '…' cannot be used"
The server started with the other provider's key. Either set the named variable, or choose a model from the provider whose key is present.

### "Model … does not support resolution/aspect ratio …"
The requested option is not valid for the chosen model, and the request is rejected before any API call. Check the [Models](#models) table — for example, Lite is `1K` only, Pro does not support the extreme aspect ratios, only Flash supports `0.5K` and `1:4`/`4:1`/`1:8`/`8:1`, and OpenAI models accept `1K`/`2K` and the ten base ratios. Either switch models or pick a supported value.

### "Model … does not accept 'quality'" / "does not accept 'temperature'"
`quality` is OpenAI-only and `temperature` is Gemini-only. Omit the option, or switch to a model of the other provider. Neither has a schema default, so an option only reaches the request when you send it.

### "OpenAI denied access (403)"
GPT Image models may require organisation verification in the [OpenAI dashboard](https://platform.openai.com/settings/organization/general). Until that clears, use a Gemini model.

### "OpenAI's content moderation blocked this request"
The prompt or an input image tripped OpenAI's moderation. The message names the stage and categories; rephrase the prompt or change the inputs.

### "Content was blocked"
The prompt may have triggered safety filters. Try rephrasing with less explicit or controversial content.

### "Rate limit exceeded"
You've made too many requests. Wait a few minutes before trying again. OpenAI tier-1 accounts allow about 5 images per minute, so `num_images: 4` on a GPT Image model is close to the ceiling.

### "Image file not found"
Verify the image path is correct. Use absolute paths or paths relative to home (`~/`).

### "Image exceeds 7MB limit"
Resize your input image to be smaller than 7MB.

## License

[MIT](LICENSE)
