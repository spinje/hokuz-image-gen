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
}
```

### 2. Safety Settings Require SDK Enums

The `@google/genai` SDK requires enum values, not strings:

```typescript
// ❌ WRONG - Type error
safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }]

// ✅ CORRECT - Use imported enums
import { HarmCategory, HarmBlockThreshold } from "@google/genai";
safetySettings: [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE }
]
```

### 3. responseModalities Must Be Mutable

```typescript
// ❌ WRONG - readonly tuple not assignable to string[]
responseModalities: ["TEXT", "IMAGE"] as const

// ✅ CORRECT - Cast to mutable array
responseModalities: ["TEXT", "IMAGE"] as string[]
```

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

### Making Requests

```typescript
const response = await client.models.generateContent({
  model: MODEL_ID,  // "gemini-3-pro-image-preview"
  contents: [
    {
      role: "user",
      parts: [
        { text: prompt },
        // For images:
        { inlineData: { mimeType: "image/png", data: base64String } }
      ],
    },
  ],
  config: {
    temperature: 1.0,
    responseModalities: ["TEXT", "IMAGE"] as string[],
    safetySettings: [...],
  },
});
```

### Parsing Responses

The response structure:
```typescript
response.candidates[0].content.parts[] →
  { text: "..." }           // Text parts
  { inlineData: { mimeType, data } }  // Image parts (base64)
```

Always check for empty candidates (content blocked).

## File Utility Patterns

### Path Resolution Logic

```typescript
// Input: "~/images" or "~/images/" → Directory, generate timestamp filename
// Input: "~/images/foo.png" → Use exact path
// Input: "~/images/foo" (no extension) → Append format extension

// For multiple images, append index: foo-1.png, foo-2.png
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
export GOOGLE_API_KEY="..."
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
| `MODEL_ID` | `gemini-3-pro-image-preview` | Nano Banana Pro model |
| `ASPECT_RATIOS` | 10 options | `1:1` through `21:9` |
| `RESOLUTIONS` | `1K`, `2K`, `4K` | 4K = highest quality |
| `maxInputImages` | 14 | API limit for editing |
| `maxOutputImages` | 4 | Per-request limit |
| `maxInputImageSize` | 7MB | Per-image limit |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Google Gemini API client |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `zod` | Schema validation (required by MCP SDK) |

## Common Tasks

### Update the model version

1. Change `MODEL_ID` in `src/constants.ts`
2. Check if API parameters changed (aspect ratios, resolutions, etc.)
3. Update safety settings if new categories exist
4. Rebuild and test

### Add support for a new output format

1. Add to `OUTPUT_FORMATS` array in `constants.ts`
2. Add MIME type mapping in `MIME_TYPES`
3. Add file extension in `FILE_EXTENSIONS`
4. Rebuild

### Modify safety settings

Safety is configured inline in `gemini-client.ts` in both `generateImage()` and `editImage()` functions. All four harm categories are set to `BLOCK_NONE` for maximum permissiveness.

## File Locations Quick Reference

| What | Where |
|------|-------|
| API key validation | `services/gemini-client.ts:getApiKey()` |
| Image generation | `services/gemini-client.ts:generateImage()` |
| Image editing | `services/gemini-client.ts:editImage()` |
| Response parsing | `services/gemini-client.ts:parseResponse()` |
| File saving | `services/file-utils.ts:saveBase64Image()` |
| Path resolution | `services/file-utils.ts:resolveOutputPath()` |
| Tool descriptions | Top of each `tools/*.ts` file |
