# Nano Banana MCP Server

An MCP (Model Context Protocol) server for generating and editing images using Google's Gemini API. The current implementation uses the `gemini-3-pro-image-preview` model ID in `src/constants.ts`.

## Features

- **Text-to-Image Generation**: Create images from detailed text prompts
- **Image Editing**: Modify existing images with natural language instructions
- **Style Transfer**: Apply artistic styles from reference images
- **Multi-Image Composition**: Combine up to 14 images into new compositions
- **High Resolution**: Support for 1K, 2K, and 4K output resolutions
- **Output Path Handling**: Save generated images to local files with configurable filename extensions

## Prerequisites

- Node.js 18 or higher
- A Google AI Studio API key ([Get one here](https://aistudio.google.com/))

## Installation

```bash
# Clone the repository
git clone https://github.com/andfal/nano-banana-mcp-server.git
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
| `output_path` | string | Yes | - | File path to save the image (directory or full path) |
| `aspect_ratio` | string | No | `"1:1"` | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| `resolution` | string | No | `"1K"` | Quality: `1K`, `2K`, `4K` |
| `output_format` | string | No | `"png"` | Saved filename extension: `png`, `jpeg`, `webp` |
| `num_images` | number | No | `1` | Number of images (1-4) |
| `temperature` | number | No | `1.0` | Creativity (0.0-2.0) |

**Examples:**

```
prompt: "A serene mountain lake at sunset with snow-capped peaks"
output_path: ~/images/

prompt: "Professional headshot of a confident businesswoman, studio lighting"
output_path: ~/images/headshot.png
aspect_ratio: 3:4
```

### nanobanana_edit_image

Edit existing images using text instructions.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Editing instruction |
| `image_paths` | string[] | Yes | - | Array of image paths or URLs (1-14 images) |
| `output_path` | string | Yes | - | File path to save result (directory or full path) |
| `aspect_ratio` | string | No | `"auto"` | Aspect ratio (or `auto` to preserve original) |
| `resolution` | string | No | `"1K"` | Quality: `1K`, `2K`, `4K` |
| `output_format` | string | No | `"png"` | Saved filename extension: `png`, `jpeg`, `webp` |
| `num_images` | number | No | `1` | Number of variations (1-4) |
| `temperature` | number | No | `1.0` | Creativity (0.0-2.0) |

**Examples:**

```
prompt: "Remove the background and replace with pure white"
image_paths: ["~/photos/portrait.jpg"]
output_path: ~/edited/portrait-nobg.png

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
