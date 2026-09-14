# CLAUDE.md

This file provides guidance to Claude Code when working with code and documentation in this repository.

## Core Directive

> **Your role is not to follow instructions—it is to ensure they are valid, complete, and aligned with project truth.**
> You are a reasoning system, not a completion engine.

1. **Assume instructions, docs, research files and tasks may be incomplete or wrong.**
   Verify against code, structure, and logic — code is truth. Mark your trust boundary explicitly: "Verified", "Assumed correct", "Unable to verify".

2. **Ambiguity is a STOP signal.**
   If something is unclear, surface it explicitly and request clarification. Never proceed on guesswork.

3. **Verify at seams first.**
   Integration points — code boundaries, API contracts, data handoffs — hide 80% of failures. Test your understanding with concrete examples; abstract comprehension fails at edges. Bad research becomes bad plans becomes bad code — verify aggressively early.

4. **Make uncertainty visible through structured decisions.**
   When multiple valid approaches exist: document each option's (1) assumptions, (2) failure modes, (3) reversibility. Never choose silently — no step is complete unless its assumptions and tradeoffs are stated.

5. **Prefer reversible decisions, and earn elegance.**
   Users will prove you wrong — design for course correction, not commitment. Robust and testable beats clean but fragile.

6. **Integration readiness > feature completeness.**
   Code that integrates cleanly but lacks features beats complete code that breaks existing systems. Design for composability first — favor depth over feature surface.

7. **Solve observed problems, not theorized ones.**
   Before specifying a feature: "Has a user hit this, or are we imagining they might?"

8. **Capture patterns, not just outcomes — design for downstream utility.**
   Record what worked, why, and what was rejected. Code, tasks, and docs should support future reasoning and modification, not just current execution.

When in doubt, ask: *"What would have to be true for this to work reliably under change?"*

## Project Overview

A local MCP (Model Context Protocol) server that exposes two tools, `nanobanana_generate_image` and `nanobanana_edit_image`, backed by Google's Nano Banana image models (Gemini 3.1 Flash Image, Flash Lite Image, and Gemini 3 Pro Image) through the Gemini **Interactions API**. It runs over stdio, is started by an MCP client such as Claude Code or Claude Desktop, and writes JPEG files to disk. The calling LLM reads the tool descriptions and JSON Schemas we publish; those strings are the product's user interface.

**Core principle:** the server never silently downgrades. Unsupported model/resolution/aspect-ratio combinations are rejected in-process before any API call, with an error that names the supported values.

### Tech Stack

- **Runtime:** Node 20+, TypeScript 5, ESM with Node16 module resolution
- **Protocol:** `@modelcontextprotocol/sdk` (`McpServer`, stdio transport)
- **Model API:** `@google/genai` (`client.interactions.create`)
- **Validation:** Zod 4 (input/output schemas, published to clients as JSON Schema)
- **Tooling:** Vitest, ESLint 9+ flat config with `typescript-eslint`, GitHub Actions on pull requests

### Project Structure

```
.
├── src/
│   ├── index.ts                    # Entry point: API-key check, stdio transport
│   ├── server.ts                   # createServer(); name/version read from package.json
│   ├── constants.ts                # Models, capability registry, aspect ratios, resolutions, limits, defaults
│   ├── types.ts                    # Shared interfaces, ErrorType enum, McpError
│   ├── schemas/
│   │   ├── generate.ts             # Zod input/output schema for nanobanana_generate_image
│   │   └── edit.ts                 # Zod input/output schema for nanobanana_edit_image ('auto' aspect ratio)
│   ├── services/
│   │   ├── gemini-client.ts        # Interactions API: request build, response parse, error mapping
│   │   ├── file-utils.ts           # Output path resolution, image loading (file/URL), base64 helpers
│   │   └── __tests__/              # Unit tests for the two services (SDK mocked, real temp dirs)
│   ├── tools/
│   │   ├── generate-image.ts       # TOOL_DESCRIPTION + handler (num_images loop, saving)
│   │   ├── edit-image.ts           # TOOL_DESCRIPTION + handler (image loading, 'auto')
│   │   └── __tests__/              # Tool tests through a real MCP client over an in-memory transport
│   └── __tests__/
│       ├── harness.ts              # connectTestClient(): real server + SDK Client over InMemoryTransport
│       ├── server.test.ts          # Published tool contract (names, annotations, JSON Schema)
│       └── constants.test.ts       # Capability validation helper
├── dist/                           # tsc output (gitignored); tests are excluded from emit
├── .github/workflows/ci.yml        # PR gate: build, typecheck, lint, test
├── eslint.config.js, vitest.config.ts, tsconfig.json
├── README.md                       # User-facing docs incl. hand-maintained model speed/cost tables
└── CLAUDE.md                       # This file
```

**Tool pattern** — each tool is three files with one job each: `schemas/<tool>.ts` (Zod shapes + `.describe()` strings the LLM reads), `tools/<tool>.ts` (the big `TOOL_DESCRIPTION` template string, defaults, orchestration, response formatting), and the shared services. Registration happens in `server.ts`. Tool names carry the `nanobanana_` prefix.

## Dev Environment

- **Node ≥ 20.** `GEMINI_API_KEY` (preferred) or `GOOGLE_API_KEY` must be set to start the server; tests need neither.
- `npm run build` — `tsc` to `dist/` (test files excluded)
- `npm run dev` — `tsx watch src/index.ts`
- `npm start` — run the built server over stdio
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint, `--max-warnings=0`
- `npm test` / `npm run test:watch` — Vitest (~0.5 s, no network)
- `npm run check` — typecheck + lint + test. **This is the gate. Run it before calling a task done.** CI runs the same steps plus the build on every pull request.
- `npx @modelcontextprotocol/inspector node dist/index.js` — poke the tools interactively
- `claude mcp add nano-banana --scope local --transport stdio --env GEMINI_API_KEY="$GEMINI_API_KEY" -- node "$PWD/dist/index.js"` — register with Claude Code, then `/mcp` to confirm

## Critical Gotchas

### 1. `.default()` in a Zod schema controls the published contract

The MCP SDK validates incoming arguments with our Zod schema and passes the **parsed** result to the handler, so defaults are applied by the SDK. More importantly, `.default()` is what makes a field *optional* in the JSON Schema clients see: drop it and the SDK marks the field `required` and rejects every call that omits it (pinned by `src/__tests__/server.test.ts`). Handlers still apply `params.x ?? DEFAULTS.x` as defence in depth; keep doing that, but do not rely on it to make a field optional.

### 2. Image options live in `response_format`, not `generation_config`

The client uses the **Interactions API** (`client.interactions.create`). Aspect ratio, resolution, and MIME type go in `response_format` (an `ImageResponseFormat`). `generation_config.image_config` exists but is `@deprecated` in the SDK — do not use it.

```typescript
response_format: {
  type: "image",
  image_size: "1K",          // API token: "512" | "1K" | "2K" | "4K" (0.5K -> "512")
  mime_type: "image/jpeg",   // JPEG only; see gotcha 3
  aspect_ratio: "16:9",      // OMIT entirely for edit "auto"
}
```

Only `temperature` goes in `generation_config`. The Interactions request has **no safety-settings field**; content moderation uses Google's defaults and there is nothing to configure.

### 3. These models output JPEG only

`response_format.mime_type` accepts only `"image/jpeg"`; the SDK types it as that literal and the API returns HTTP 400 for anything else. So `OUTPUT_FORMATS` is `["jpeg"]` and every saved file is `.jpg`. Do not add PNG/WebP output without a transcoding dependency (a deliberate non-goal). Input images may be PNG/WebP/GIF/HEIC.

### 4. stdout is the MCP protocol channel

Anything written to stdout corrupts the JSON-RPC stream. Log with `console.error` only. ESLint enforces this (`no-console` allows `error`/`warn`).

### 5. Relative imports end in `.js`

`tsconfig` uses Node16 module resolution, so `import { x } from "./constants.js"` even though the source file is `.ts`. A bare `./constants` import compiles to a runtime "module not found".

### 6. Some capability flags are metadata only

`IMAGE_MODEL_CAPABILITIES[*].supportsPdfInput / supportsSearchGrounding / supportsStructuredOutputs` are recorded but **not wired to anything**. Only `resolutions` and `aspectRatios` drive validation. Do not assume the others gate behaviour.

### 7. Invalid arguments come back as a tool result, not a protocol error

When the SDK's schema validation rejects a call, the client receives `{ isError: true, content: [{ text: "Input validation error: ..." }] }`, not a JSON-RPC error. Tests and clients should check `isError`, not expect a rejection.

## Testing

`npm test` runs 54 tests in about half a second with no network access. The suite exists to make the gotchas above and the invariants below fail loudly when broken; it is not a coverage exercise.

- `services/__tests__/file-utils.test.ts` — output path rules (trailing separator, extension replacement, `-N` suffixes in both modes, `~`), 7 MB limit, URL loading via mocked `fetch`.
- `services/__tests__/gemini-client.test.ts` — exact Interactions request shape, `aspect_ratio` omitted for `auto`, `parseInteraction` de-dup/fallbacks, API error mapping, `GEMINI_API_KEY` precedence.
- `tools/__tests__/*.test.ts` — defaults reach the service, validation before image loading and before any API call, `num_images` loop and partial-failure warning, files written, schema-boundary rejections.
- `__tests__/server.test.ts` — tool names, annotations, JSON Schema enums/defaults/`required`, package.json version. `__tests__/constants.test.ts` — validation messages and the "defaults are valid" invariant.

**How tool tests work:** `connectTestClient()` in `src/__tests__/harness.ts` builds the real server via `createServer()` and connects an SDK `Client` over `InMemoryTransport`. Only the Gemini service functions are mocked (`vi.mock` with `importOriginal`, so `validateGenerationConfig` stays real). This exercises the SDK's input and output schema validation exactly as a production client would.

**What to test:** the seams — request building, response parsing, path resolution, default application, validation order, and the published schema. Exact assertions on deterministic values; every "must not be called / must not appear" paired with a presence assertion in the same medium.

**What never to test:** Zod's own validation, the MCP SDK's transport, the Google SDK, or what the compiler already checks (`Record<ImageModel, ...>` completeness, enum membership). One test per archetype; do not restate a generate test for edit unless edit's behaviour differs.

**Before a test counts as done, mutate the code it guards and read the failure count.** A test that stays green when its behaviour breaks is deleted, not kept. Restore mutations from a saved copy, never with `git checkout -- <file>` on a dirty tree.

**Manual verification** after changes that touch the API path: `npm run build`, register with an MCP client, run one real generation and one real edit, and try one invalid combination (Lite + 2K) to see the pre-flight error.

## Adding a Parameter to an Existing Tool

1. **Schema** (`src/schemas/generate.ts` / `edit.ts`): `new_param: z.enum(OPTIONS).default(DEFAULTS.newParam).describe("...")`. The `.describe()` string is read by the LLM — say what the options mean and name the default.
2. **Handler** (`src/tools/*.ts`): `const newParam = params.new_param ?? DEFAULTS.newParam;` then pass it into `GenerationConfig`.
3. **Service** (`src/services/gemini-client.ts`) if it changes the request.
4. **Tool description** (the `TOOL_DESCRIPTION` template at the top of the tool file): add it to the Args list.
5. **Tests in the same change:** the request-shape assertion in `gemini-client.test.ts` is an exact `toEqual` and will fail until updated; add a schema-default assertion in `server.test.ts` if the field has one.
6. **README** parameter table.
7. `npm run check`.

## Adding a New Tool

1. `src/schemas/newtool.ts` — `NewToolInputSchema = z.object({...}).strict()`, `NewToolOutputSchema`, inferred types.
2. `src/tools/newtool.ts` — `registerNewTool(server)` calling `server.registerTool("nanobanana_new_tool", { title, description, inputSchema, outputSchema, annotations }, handler)`. Copy the annotations block and the `catch` → `{ content, structuredContent: { success: false, error }, isError: true }` pattern from an existing tool.
3. Register in `src/server.ts` and add the line to the startup banner in `src/index.ts`.
4. Tests: a `tools/__tests__/newtool.test.ts` through `connectTestClient()`, and update the tool-name list in `server.test.ts`.
5. README Tools section. `npm run check`.

## Google GenAI SDK Patterns

One singleton `GoogleGenAI` client (key resolved `GEMINI_API_KEY` → `GOOGLE_API_KEY`). Generate sends `input: prompt` (a string); edit sends `input: [...imageBlocks, { type: "text", text: prompt }]` with images first so "first/second image" prompts resolve in order. Both use `response_format: buildResponseFormat(config)` (gotcha 2) and `generation_config: { temperature }`.

**Response parsing** (`parseInteraction`, exported): reads `interaction.output_image` first, then scans `steps[]` of type `model_output` for additional `image`/`text` blocks (de-duplicated by data), falls back to `output_text` for the description, and throws `CONTENT_BLOCKED` if no image was found.

**Error mapping** (`handleApiError`): `McpError`s we raised pass through unchanged; otherwise message heuristics map 429/"rate limit" → `API_RATE_LIMIT`, 401/403/"api key" → `MISSING_API_KEY`, "blocked"/"safety" → `CONTENT_BLOCKED`, else `API_ERROR`.

## File Utility Patterns

`resolveOutputPath(outputPath, format, index)`:

```
"~/images/" or an existing directory  → directory mode: create if missing,
                                         image-YYYY-MM-DD-HHmmss-SSS[-N].jpg
"~/images/foo.png"                     → file mode: extension replaced → foo.jpg
"~/images/foo"                         → file mode: extension appended → foo.jpg
A TRAILING SEPARATOR always means directory, even if it does not exist yet.
index ≥ 1 appends -2, -3, … in both modes (this is the same-millisecond collision guard).
```

`loadImage(pathOrUrl)` dispatches on `http(s)://` to `fetch` (MIME from `content-type`) or reads the file (MIME from extension, default `image/png`). Both enforce `LIMITS.maxInputImageSize` (7 MB).

## Error Handling

All failures become `McpError(type, message, details?)` with an actionable message that starts with `Error:`. Handlers catch everything and return `{ content: [{ type: "text", text }], structuredContent: { success: false, images: [], error }, isError: true }`. Validation (`validateGenerationConfig`) runs before any API call and, in edit, before any image is loaded.

## Constants Reference (`src/constants.ts`)

- `IMAGE_MODELS`: `gemini-3.1-flash-image` (default, Nano Banana 2), `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`. Exact IDs; do not guess new ones.
- `IMAGE_MODEL_CAPABILITIES`: per-model `resolutions` and `aspectRatios` drive validation (gotcha 6).
- `ASPECT_RATIOS`: 10 base + `1:4`, `4:1`, `1:8`, `8:1` (flash only). `RESOLUTIONS`: `0.5K`, `1K`, `2K`, `4K` (`0.5K` → API `"512"`; Lite is `1K` only; Pro has no `0.5K`).
- `LIMITS`: 14 input images, 4 output images, 7 MB per input, temperature 0–2. `DEFAULTS`: flash, `1:1`, `1K`, jpeg, 1 image, temperature 1.0 (pinned as a valid combination by test).

`num_images > 1` is **repeated independent requests**, not an API count parameter. The loop stops early on a failure if at least one image was collected and the response text warns about the shortfall. Edit `aspect_ratio: "auto"` means `config.aspectRatio` is `undefined` and `aspect_ratio` is omitted from the request; never coerce it to `1:1`.

### Adding or updating a model

1. Add the exact ID to `IMAGE_MODELS` and an entry to `IMAGE_MODEL_CAPABILITIES`.
2. New resolution/aspect tokens go in `RESOLUTIONS` / `ASPECT_RATIOS` (and `IMAGE_SIZE_API_VALUES` for a resolution).
3. Smoke-test the ID against the Interactions API; IDs are not guaranteed stable.
4. Update the model enum assertion in `server.test.ts`, the model paragraphs in both `TOOL_DESCRIPTION`s and both schemas' `model.describe()`, and the README model and cost tables. Speed/cost figures are hand-maintained in those four places.

## Claude's Operating Guidelines

**Show Before You Code** — when a change alters anything the calling LLM reads or a user sees: a `TOOL_DESCRIPTION`, a schema `.describe()`, the JSON Schema shape (new field, changed default, changed `required`), response text, or an error message. Show the before/after string and confirm before implementing. Internal refactors, new tests, and doc-only edits do not trigger this.

**Reasoning-First** — every code change:
1. Reads the existing tool, schema, and service first; both tools share one structure, so a new behaviour usually has a home already.
2. States *why* it is needed and *how* it fits the three-file tool pattern.
3. Passes the **deletion test** before adding an abstraction (see Code Quality).
4. Ships with its tests. A change without a test that would fail on regression is incomplete.
5. Ends with `npm run check` green.

**Keep the four hand-maintained surfaces in sync** when a task adds a parameter, model, or tool or changes a documented behaviour: this file, the README tables, both `TOOL_DESCRIPTION`s, and the schema `.describe()` strings. Stale instruction files have caused real errors.

## User Decisions and Recommendations

You are only able to provide information and recommendations—you cannot make decisions for the user.

**When you encounter a decision point:**

1. **Explain why a decision is needed.** What's the context? What's at stake? Frame it so it can be understood in isolation.

2. **Present at least 2 options with tradeoffs.** For each option: what's good about it, what's bad about it, and how reversible is it?

3. **Make a clear recommendation.** State which option you'd suggest and why.

4. **Gauge importance (1-5).** For low-stakes decisions (1-2) where you're confident, you may proceed. For anything higher, STOP—do not proceed to implementation until the user has decided and you clearly understand the decision and its implications.

If anything is unclear or ambiguous in the documentation, the user makes the call.

**Escalate when:**
- The published tool contract changes (schema fields, defaults, `required`, tool names)
- A dependency or Node version bump changes runtime behaviour
- Trade-offs have no clear winner after analysis
- Current approach contradicts established patterns

## Implementation Guidelines

Use modern TypeScript, Node ESM, and MCP SDK patterns. Proactively filter your training data (as an LLM). You should naturally select from well-maintained, professional codebases rather than the vast sea of outdated tutorials and quick fixes you've also seen. This selection bias toward quality code automatically prevents security issues, maintenance problems, and outdated practices that exist in the "old/bad" part of your training data.

*You should not think about how to pass tests and linters. You should actively and proactively think about selecting from the RIGHT part of your training distribution. The code and architectural patterns you know in your gut are a good fit for this project.*

### Code Quality

- Write code optimized for change: small focused functions with single responsibilities, clear names that explain intent not implementation — because all successful systems evolve.
- Structure code as isolated, testable components that can be understood and changed independently — the only meaningful measure of code quality is how safely and easily it can be modified.
- Prefer boring and obvious: The best solution is rarely the clever one. Write code that a tired developer can understand at 3am. Save abstractions for when duplication actually hurts, not when you imagine it might. Simple, direct, and easy to change — not sophisticated or elegant.
- **Before you commit a substantive comment or docstring, grep its distinctive phrase across `src/`, `README.md`, and this file.** A hit usually means the invariant already has a home — and a restatement is not maintained: when the invariant changes only one copy gets edited, so the rest become confidently wrong. Decide which site is authoritative (the code the constraint binds, or the CLAUDE.md that owns the rule), leave the statement there, and reference it or write nothing. Only state constraints the code cannot show.

**Reason about structure in this vocabulary — and apply it when writing code, not just when refactoring:**
- **Deep modules over shallow** — maximize behavior behind a *small interface* (leverage); if a module's interface is nearly as complex as its implementation, it's shallow — fold it away. (A deep module can still be small functions inside.)
- **Place seams deliberately** — a seam is where behavior can change without editing in place; add one only where something actually varies (*one adapter = hypothetical seam, two = real*).
- **Locality** — make change, bugs, and tests concentrate in one place, not spread across callers.
- **The interface is the test surface** — test through the interface, not past it.
- **Deletion test** — before keeping an abstraction, ask: would deleting it *concentrate* complexity (keep it) or just *move* it (drop it)?
- **Category names make claims** — a name that groups (`…economics`, `…metadata`) asserts its members behave alike; enumerate them and check. False for one member means the *abstraction* is wrong, not the name.

**More architecture is not more depth** — depth comes from *consolidating* behavior behind a smaller interface, not from adding layers or seams; the simplest structure that yields real depth wins.

*Write code and make decisions by mirroring the top 10% of the best codebases appropriate for this project's scale - think well-written and purposeful applications by known developers or companies, not old enterprise saas platforms. Prefer boring, obvious code over clever abstractions. Ignore the rest. And save the fancy patterns for when they're actually needed.*

## Project Status

v1.0.0: two tools, three selectable models, JPEG output, in-process capability validation, a test suite and CI gate. Enhancement work starts from here; there is no roadmap file yet.
