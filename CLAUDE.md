# CLAUDE.md - AI Agent Development Guide

This document is for AI coding agents working on this MCP server. It contains implementation details, patterns, and gotchas not covered in the README.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     index.ts                            │
│  - Server initialization (McpServer)                    │
│  - Tool registration                                    │
│  - stdio transport connection                           │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                      tools/                             │
│  generate-image.ts  │  edit-image.ts                    │
│  - Tool registration with server.registerTool()        │
│  - Parameter handling (apply defaults manually!)        │
│  - Response formatting                                  │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────────┐
│     schemas/            │  │        services/            │
│  Zod validation schemas │  │  gemini-client.ts (API)     │
│  Input/Output types     │  │  file-utils.ts (filesystem) │
└─────────────────────────┘  └─────────────────────────────┘
```

## Critical Gotchas

### 1. Zod Defaults Don't Auto-Apply in MCP Handlers

The MCP SDK passes raw input to handlers. Zod `.default()` values are NOT automatically applied.

```typescript
// ❌ WRONG - params.temperature might be undefined
async (params: GenerateImageInput) => {
  const config = { temperature: params.temperature }; // Could be undefined!
}

// ✅ CORRECT - Apply defaults manually with nullish coalescing
async (params) => {
  const temperature = params.temperature ?? DEFAULTS.temperature;
  const model = params.model ?? DEFAULTS.model;
}
```

This applies to `model` too — it is a Zod enum with a default, but the handler must still apply `params.model ?? DEFAULTS.model` manually.

### 2. Image options live in `response_format`, not `generation_config`

The client uses the **Interactions API** (`client.interactions.create`), not
`client.models.generateContent`. Aspect ratio, resolution, and MIME type go in
`response_format` (an `ImageResponseFormat` object). `generation_config.image_config`
exists but is marked `@deprecated` in the SDK — do not use it.

```typescript
response_format: {
  type: "image",
  image_size: "1K",          // API token: "512" | "1K" | "2K" | "4K" (0.5K -> "512")
  mime_type: "image/jpeg",   // JPEG only; see gotcha 3
  aspect_ratio: "16:9",      // OMIT entirely for edit "auto"
}
```

Only `temperature` goes in `generation_config`. Safety settings are **not
configurable** via the Interactions API request (there is no such field), so the
old `BLOCK_NONE` behavior is gone — content moderation uses Google's defaults.

### 3. These models output JPEG only

`response_format.mime_type` accepts only `"image/jpeg"` — the API returns HTTP 400
for `"image/png"` (verified live), and the default output is JPEG regardless. So
`OUTPUT_FORMATS` is `["jpeg"]` and every saved file is `.jpg`. Do not add PNG/WebP
back as output formats without adding a transcoding dependency (a deliberate
non-goal). Input images may still be PNG/WebP/etc.

### 4. stdout is Reserved for MCP Protocol

Never use `console.log()` - it interferes with MCP communication:

```typescript
// ❌ WRONG
console.log("Debug info");

// ✅ CORRECT
console.error("Debug info");  // stderr is safe
```

## Adding a New Parameter to Existing Tools

1. **Update the Zod schema** in `src/schemas/generate.ts` or `edit.ts`:
   ```typescript
   new_param: z
     .string()
     .optional()
     .default("default_value")
     .describe("Description for LLM")
   ```

2. **Apply the default in the handler** in `src/tools/*.ts`:
   ```typescript
   const newParam = params.new_param ?? "default_value";
   ```

3. **Pass to the service** if needed in `src/services/gemini-client.ts`

4. **Update the tool description** (the big template string) to document the new param

5. **Rebuild**: `npm run build`

## Adding a New Tool

1. **Create the schema** in `src/schemas/newtool.ts`:
   ```typescript
   export const NewToolInputSchema = z.object({ ... }).strict();
   export const NewToolOutputSchema = z.object({ ... });
   export type NewToolInput = z.infer<typeof NewToolInputSchema>;
   ```

2. **Create the tool file** in `src/tools/newtool.ts`:
   ```typescript
   export function registerNewTool(server: McpServer): void {
     server.registerTool(
       "nanobanana_new_tool",  // Use nanobanana_ prefix!
       {
         title: "...",
         description: TOOL_DESCRIPTION,  // Detailed description for LLM
         inputSchema: NewToolInputSchema,
         outputSchema: NewToolOutputSchema,
         annotations: {
           readOnlyHint: false,
           destructiveHint: false,
           idempotentHint: false,
           openWorldHint: true,
         },
       },
       async (params) => { ... }
     );
   }
   ```

3. **Register in index.ts**:
   ```typescript
   import { registerNewTool } from "./tools/newtool.js";
   // In createServer():
   registerNewTool(server);
   ```

4. **Rebuild and test**

## Google GenAI SDK Patterns

### Client Initialization (Singleton)

```typescript
let clientInstance: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!clientInstance) {
    clientInstance = new GoogleGenAI({ apiKey: getApiKey() });
  }
  return clientInstance;
}
```

### Making Requests (Interactions API)

```typescript
// Generate: input is a plain string
const interaction = await client.interactions.create({
  model: config.model,                       // e.g. "gemini-3.1-flash-image"
  input: prompt,
  response_format: { type: "image", image_size: "1K", mime_type: "image/jpeg" },
  generation_config: { temperature: 1.0 },
});

// Edit: input is an array of typed content blocks (images first, then text)
const interaction = await client.interactions.create({
  model: config.model,
  input: [
    { type: "image", mime_type: "image/png", data: base64String },
    { type: "text", text: prompt },
  ],
  response_format: { type: "image", image_size: "1K", mime_type: "image/jpeg" },
  generation_config: { temperature: 1.0 },
});
```

Note: the SDK types `response_format.mime_type` as the literal `"image/jpeg"`, so a
cast is used (`MIME_TYPES[fmt] as "image/jpeg"`). `image_size` uses `"512"` for the
`0.5K` public token — see `IMAGE_SIZE_API_VALUES`.

### Parsing Responses

The interaction response exposes:
```typescript
interaction.output_image  →  { data: base64, mime_type }   // convenience: last image
interaction.output_text   →  concatenated model text
interaction.steps[]       →  model_output steps whose `content[]` blocks
                             ({ type: "image", data, mime_type } | { type: "text", text })
```

`parseInteraction()` reads `output_image` first, then scans `steps` for any
additional image/text blocks (de-duped). If no image is found, it throws
`CONTENT_BLOCKED`.

## File Utility Patterns

### Path Resolution Logic

`resolveOutputPath(outputPath, format, index)` resolves the final file path. The
saved extension always matches the output format (JPEG → `.jpg`); any extension on
the input path is replaced, never trusted.

```typescript
// "~/images/" or an existing directory → directory mode: create if missing,
//     write image-YYYY-MM-DD-HHmmss-SSS.jpg (ms timestamp avoids collisions)
// "~/images/foo.png"                    → file mode: extension normalized → foo.jpg
// "~/images/foo" (no extension)         → file mode: append format extension → foo.jpg
//
// A TRAILING SEPARATOR always means "directory", even if it does not exist yet.
// Multiple images append an index from the second onward: foo.jpg, foo-2.jpg, foo-3.jpg
```

### Home Directory Expansion

```typescript
const expanded = path.replace(/^~/, process.env.HOME || "");
```

## Error Handling Pattern

All errors should be converted to `McpError` with actionable messages:

```typescript
throw new McpError(
  ErrorType.INVALID_IMAGE_PATH,
  `Error: Image file not found at '${path}'. Ensure the path is correct and the file exists.`
);
```

In tool handlers, catch and format:

```typescript
catch (error) {
  const errorMessage = error instanceof McpError
    ? error.message
    : `Error: Unexpected error. ${error instanceof Error ? error.message : String(error)}`;

  return {
    content: [{ type: "text", text: errorMessage }],
    structuredContent: { success: false, error: errorMessage },
    isError: true,
  };
}
```

## Testing

### With MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### With Claude Code

```bash
export GEMINI_API_KEY="..."   # GOOGLE_API_KEY also works
claude --mcp-config mcp-config.json
```

Then ask Claude to use the tools.

### Manual Verification

After changes, always:
1. `npm run build` - Verify no TypeScript errors
2. Test the happy path with a real generation
3. Test error handling (invalid path, missing image, etc.)

## Constants Reference

Key values in `src/constants.ts`:

| Constant | Value | Notes |
|----------|-------|-------|
| `IMAGE_MODELS` | 3 model IDs | `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` |
| `DEFAULT_IMAGE_MODEL` | `gemini-3.1-flash-image` | Nano Banana 2 (also `DEFAULTS.model`) |
| `IMAGE_MODEL_CAPABILITIES` | registry | Per-model resolutions/aspect ratios + metadata; drives validation |
| `ASPECT_RATIOS` | 14 options | 10 base + 4 flash-only extremes (`1:4`, `4:1`, `1:8`, `8:1`) |
| `RESOLUTIONS` | `0.5K`, `1K`, `2K`, `4K` | `0.5K` maps to API `"512"` via `IMAGE_SIZE_API_VALUES` |
| `OUTPUT_FORMATS` | `jpeg` | JPEG only (see gotcha 3) |
| `maxInputImages` | 14 | API limit for editing |
| `maxOutputImages` | 4 | Per-request limit |
| `maxInputImageSize` | 7MB | Per-image limit |

### Model capability validation

Validation happens **before** any API call. `getUnsupportedModelOptionMessage()`
in `constants.ts` is a pure helper (returns a message string or `null`); the
service wraps it as `validateGenerationConfig()` which throws
`McpError(INVALID_MODEL_OPTION, ...)`. Tools call `validateGenerationConfig()`
early (edit calls it *before* loading input images) so bad model/resolution/
aspect-ratio combinations fail fast with no wasted work.

### num_images and aspect_ratio "auto"

- `num_images > 1` is implemented by making **repeated independent requests**
  (each asking for one image), not an API count parameter. The loop stops early
  on a per-request failure if at least one image was already collected, and
  warns if fewer than requested were produced.
- Edit `aspect_ratio: "auto"` means **omit** `aspect_ratio` from `response_format`
  (internal `config.aspectRatio` is `undefined`). Never coerce `auto` to `1:1`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Google Gemini API client |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `zod` | Schema validation (required by MCP SDK) |

## Common Tasks

### Add or update a model

1. Add the exact model ID to `IMAGE_MODELS` in `src/constants.ts`
2. Add a matching entry to `IMAGE_MODEL_CAPABILITIES` (resolutions, aspect ratios, metadata)
3. If it introduces a new resolution/aspect ratio, add it to `RESOLUTIONS` /
   `ASPECT_RATIOS` (and `IMAGE_SIZE_API_VALUES` for a new resolution token)
4. Smoke-test the model ID against the Interactions API (IDs are not guaranteed
   stable — do not guess)
5. Rebuild and test
6. Keep the docs in sync: per-model speed/cost guidance is hand-maintained in the
   tool descriptions (`tools/*.ts`) and the README "Performance & cost" tables —
   update them when models, prices, or measured latencies change

### Add support for a new output format

Currently only JPEG is supported because the Interactions API rejects other
`response_format.mime_type` values for these models. Adding PNG/WebP would require
a transcoding dependency to convert the returned JPEG — a deliberate non-goal.
If the API later supports more MIME types: add to `OUTPUT_FORMATS`, `MIME_TYPES`,
`FILE_EXTENSIONS`, and `inferOutputFormatFromPath()`, then rebuild.

### Safety settings

The Interactions API request exposes **no** safety-settings field, so the previous
`BLOCK_NONE` configuration is not carried over — content moderation uses Google's
defaults. There is nothing to configure inline.

## File Locations Quick Reference

| What | Where |
|------|-------|
| API key validation | `services/gemini-client.ts:getApiKey()` |
| Model option validation | `services/gemini-client.ts:validateGenerationConfig()` (wraps `constants.ts:getUnsupportedModelOptionMessage()`) |
| Image generation | `services/gemini-client.ts:generateImage()` |
| Image editing | `services/gemini-client.ts:editImage()` |
| Response parsing | `services/gemini-client.ts:parseInteraction()` |
| Response format build | `services/gemini-client.ts:buildResponseFormat()` |
| Model capability registry | `constants.ts:IMAGE_MODEL_CAPABILITIES` |
| Output format resolution | `services/file-utils.ts:resolveRequestedOutputFormat()` |
| File saving | `services/file-utils.ts:saveBase64Image()` |
| Path resolution | `services/file-utils.ts:resolveOutputPath()` |
| Tool descriptions | Top of each `tools/*.ts` file |
