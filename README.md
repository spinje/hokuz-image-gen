# Nano Banana MCP Server

An MCP (Model Context Protocol) server for generating and editing images using Google's Gemini image models via the [Interactions API](https://ai.google.dev/gemini-api/docs/image-generation). Both tools accept an optional `model` parameter; the default is `gemini-3.1-flash-image` (Nano Banana 2).

- [Features](#features)
- [Models](#models)
- [Performance & cost](#performance--cost)
- [Prerequisites](#prerequisites) · [Installation](#installation) · [Configuration](#configuration)
- [Usage](#usage)
- [Tools](#tools) — [`nanobanana_generate_image`](#nanobanana_generate_image) · [`nanobanana_edit_image`](#nanobanana_edit_image)
- [Troubleshooting](#troubleshooting)

## Features

- **Selectable models**: Choose between Nano Banana 2, Nano Banana 2 Lite, and Nano Banana Pro (see the [model table](#models) below)
- **Text-to-Image Generation**: Create images from detailed text prompts
- **Image Editing**: Modify existing images with natural language instructions
- **Style Transfer**: Apply artistic styles from reference images
- **Multi-Image Composition**: Combine up to 14 images into new compositions
- **High Resolution**: Up to 4K output (model-dependent)
- **Model-aware validation**: Unsupported model/resolution or model/aspect-ratio combinations are rejected before any API call — no silent downgrades

## Models

Select a model with the optional `model` parameter on either tool. The default is `gemini-3.1-flash-image`. All three output **JPEG only** and share the same tool interface — capability differences are validated before any API call.

| Model ID | Name | Best for | Resolutions | Extreme aspect ratios | Speed¹ | Cost²/image |
|----------|------|----------|-------------|-----------------------|--------|-------------|
| `gemini-3.1-flash-image` (default) | Nano Banana 2 | Balanced generalist | `0.5K`, `1K`, `2K`, `4K` | Yes (`1:4`, `4:1`, `1:8`, `8:1`) | ~11 s | ~$0.07 (1K) |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite | Cheapest / fastest | `1K` only | No | ~5 s | ~$0.034 |
| `gemini-3-pro-image` | Nano Banana Pro | Highest quality | `1K`, `2K`, `4K` | No | ~17 s | ~$0.13 (1K) |

## Performance & cost

**Speed** (¹): approximate wall-clock time for a single **1K** image measured through this server. Latency scales with resolution (4K is noticeably slower) and varies with prompt and API load. `num_images > 1` runs that many **separate** requests, so time and cost scale linearly (e.g. `num_images: 4` ≈ 4× a single image).

**Cost** (²): approximate per-image prices (Standard tier) at time of writing — **verify current rates on the [Google pricing page](https://ai.google.dev/gemini-api/docs/pricing)**, they change often. Higher resolutions cost more. A cell marked _n/a_ means that model does **not support** that resolution, so the request is rejected before any API call (there is no such combination to price):

| Resolution | Nano Banana 2 Lite | Nano Banana 2 (Flash) | Nano Banana Pro |
|------------|--------------------|-----------------------|-----------------|
| `0.5K`     | _n/a_              | ~$0.045               | _n/a_           |
| `1K`       | ~$0.034            | ~$0.067               | ~$0.134         |
| `2K`       | _n/a_              | ~$0.101               | ~$0.134         |
| `4K`       | _n/a_              | ~$0.151               | ~$0.240         |

**Rule of thumb:** default to **Flash** for everyday work; drop to **Lite** for drafts, thumbnails, and high-volume batches where speed and cost matter most; reach for **Pro** for hero shots, photorealism, and cinematic lighting where the extra time and cost are justified.

## Prerequisites

- Node.js 18 or higher
- A Google AI Studio API key ([Get one here](https://aistudio.google.com/))

## Installation

```bash
# Clone the repository
git clone https://github.com/spinje/nano-banana-mcp-server.git
cd nano-banana-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Set your API key as an environment variable:

```bash
export GEMINI_API_KEY="your-api-key-here"
# or, for compatibility
export GOOGLE_API_KEY="your-api-key-here"
```

## Usage

### Claude Code

Add the server to Claude Code as a local stdio MCP server:

```bash
export GEMINI_API_KEY="your-api-key-here"

claude mcp add nano-banana \
  --scope local \
  --transport stdio \
  --env GEMINI_API_KEY="$GEMINI_API_KEY" \
  -- node /absolute/path/to/nano-banana-mcp-server/dist/index.js

claude mcp list
```

`--scope local` stores the MCP server in your private Claude Code configuration for the current project, not in this repository. After starting Claude Code, run `/mcp` to verify that `nano-banana` is connected.

### Claude Desktop

Add to your Claude Desktop configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "nano-banana": {
      "command": "node",
      "args": ["/absolute/path/to/nano-banana-mcp-server/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
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

### nanobanana_generate_image

Generate images from text prompts.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description of the image to generate |
| `output_path` | string | Yes | - | File path to save the image (directory or full path). Any extension is normalized to `.jpg` |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` |
| `aspect_ratio` | string | No | `"1:1"` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`; plus `1:4`, `4:1`, `1:8`, `8:1` (flash only). Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`) |
| `output_format` | string | No | `"jpeg"` | Only `jpeg` is supported (these models output JPEG) |
| `num_images` | number | No | `1` | Number of images (1-4). Produced via repeated requests |
| `temperature` | number | No | `1.0` | Creativity (0.0-2.0) |

**Examples:**

```
prompt: "A serene mountain lake at sunset with snow-capped peaks"
output_path: ~/images/

prompt: "Professional headshot of a confident businesswoman, studio lighting"
output_path: ~/images/headshot.jpg
aspect_ratio: 3:4
```

### nanobanana_edit_image

Edit existing images using text instructions.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Editing instruction |
| `image_paths` | string[] | Yes | - | Array of image paths or URLs (1-14 images) |
| `output_path` | string | Yes | - | File path to save result (directory or full path). Any extension is normalized to `.jpg` |
| `model` | string | No | `"gemini-3.1-flash-image"` | Model ID: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` |
| `aspect_ratio` | string | No | `"auto"` | `auto` (preserve original) or any generate ratio. Rejected if unsupported by the chosen model |
| `resolution` | string | No | `"1K"` | `0.5K`, `1K`, `2K`, `4K`. Rejected if unsupported by the chosen model (Lite is `1K` only; Pro is `1K`/`2K`/`4K`) |
| `output_format` | string | No | `"jpeg"` | Only `jpeg` is supported (these models output JPEG) |
| `num_images` | number | No | `1` | Number of variations (1-4). Produced via repeated requests |
| `temperature` | number | No | `1.0` | Creativity (0.0-2.0) |

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

### Multi-Image Composition
- Combine product shots into catalogs
- Create composite scenes
- Maintain character consistency across images

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode with auto-reload
npm run dev

# Clean build artifacts
npm run clean
```

## Project Structure

```
.
├── src/
│   ├── index.ts              # Entry point
│   ├── constants.ts          # Configuration constants
│   ├── types.ts              # TypeScript types
│   ├── schemas/
│   │   ├── generate.ts       # Generate tool schema
│   │   └── edit.ts           # Edit tool schema
│   ├── services/
│   │   ├── gemini-client.ts  # Gemini API client
│   │   └── file-utils.ts     # File operations
│   └── tools/
│       ├── generate-image.ts # Generate tool
│       └── edit-image.ts     # Edit tool
├── dist/                     # Compiled output (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### "API key not found"
Ensure `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set in your environment or MCP client configuration.

### "Model … does not support resolution/aspect ratio …"
The requested option is not valid for the chosen model, and the request is rejected before any API call. Check the [Models](#models) table — for example, Lite is `1K` only, Pro does not support the extreme aspect ratios, and only Flash supports `0.5K` and `1:4`/`4:1`/`1:8`/`8:1`. Either switch models or pick a supported value.

### "Content was blocked"
The prompt may have triggered safety filters. Try rephrasing with less explicit or controversial content.

### "Rate limit exceeded"
You've made too many requests. Wait a few minutes before trying again.

### "Image file not found"
Verify the image path is correct. Use absolute paths or paths relative to home (`~/`).

### "Image exceeds 7MB limit"
Resize your input image to be smaller than 7MB.

## License

[MIT](LICENSE)
