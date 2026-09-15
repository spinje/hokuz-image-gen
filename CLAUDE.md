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

A local MCP (Model Context Protocol) server that exposes two tools, `hokuz_generate_image` and `hokuz_edit_image`, backed by two providers: Google's Nano Banana image models (Gemini 3.1 Flash Image, Flash Lite Image, Gemini 3 Pro Image) through the Gemini **Interactions API**, and OpenAI's GPT Image 2.5 models (Flare, Sunburst) through the **Images API**. The caller picks with `model`. It runs over stdio, is started by an MCP client such as Claude Code or Claude Desktop, and writes JPEG, PNG or WebP files to disk (Gemini models produce JPEG only). The calling LLM reads the tool descriptions and JSON Schemas we publish; those strings are the product's user interface.

**Core principle:** the server never silently downgrades. Unsupported combinations of model, resolution, aspect ratio and provider-only option are rejected in-process before any API call, with an error that names the supported values or the model to switch to.

### Tech Stack

- **Runtime:** Node 22+, TypeScript 5, ESM with Node16 module resolution
- **Protocol:** `@modelcontextprotocol/sdk` (`McpServer`, stdio transport)
- **Model APIs:** `@google/genai` (`client.interactions.create`) and `openai` (`client.images.generate` / `client.images.edit`; requires Node 22)
- **Validation:** Zod 4 (input/output schemas, published to clients as JSON Schema)
- **Tooling:** Vitest, ESLint 9+ flat config with `typescript-eslint`, GitHub Actions on pull requests

### Project Structure

```
.
├── src/
│   ├── index.ts                # Entry point: provider-key check, stdio transport
│   ├── server.ts               # createServer(); name/version from package.json
│   ├── constants.ts            # Models, capability registry, limits, defaults, pricing
│   ├── types.ts                # GenerationConfig, ImageResponse, ErrorType, McpError
│   ├── schemas/{generate,edit}.ts      # Zod input/output schemas (LLM reads the .describe() strings)
│   ├── providers/
│   │   ├── index.ts            # validateGenerationConfig + dispatch on the registry's `provider`
│   │   ├── gemini.ts           # Interactions API: request build, response parse, error mapping
│   │   ├── openai.ts           # Images API: size derivation, request build, parse, error mapping
│   │   └── __tests__/
│   ├── services/
│   │   ├── file-utils.ts       # Output path resolution, image loading (file/URL)
│   │   └── __tests__/
│   ├── tools/
│   │   ├── {generate,edit}-image.ts    # TOOL_DESCRIPTION + handler
│   │   └── __tests__/          # Through a real MCP client over an in-memory transport
│   └── __tests__/
│       ├── harness.ts          # connectTestClient(): real server + SDK Client, InMemoryTransport
│       ├── server.test.ts      # Published tool contract (names, annotations, JSON Schema)
│       └── constants.test.ts
├── .claude/
│   ├── agents/                 # review-* lenses + REVIEW-PROTOCOL.md (see Review Battery)
│   ├── skills/deep-review/     # /deep-review orchestrator: dispatch lenses, evaluate, action plan
│   └── commands/test-reflect.md # self-audit of tests you just wrote
├── .github/workflows/ci.yml    # PR gate: build, typecheck, lint, test
├── eslint.config.js, vitest.config.ts, tsconfig.json, tsconfig.test.json
├── README.md                   # User docs incl. hand-maintained model speed/cost tables
└── CLAUDE.md
```

**Tool pattern** — each tool is three files with one job each: `schemas/<tool>.ts` (Zod shapes + `.describe()` strings the LLM reads), `tools/<tool>.ts` (the big `TOOL_DESCRIPTION` template string, defaults, orchestration, response formatting), and the shared services. Registration happens in `server.ts`. Tool names carry the `hokuz_` prefix.

## Dev Environment

- **Node ≥ 22** (`openai@7` requires it). At least one provider key must be set to start the server: `GEMINI_API_KEY` (preferred) or `GOOGLE_API_KEY` for Gemini models, `OPENAI_API_KEY` for GPT Image models. Tests need none.
- `npm run build` — `tsc` to `dist/` (tests excluded from emit by `tsconfig.json`)
- `npm run dev` — `tsx watch src/index.ts`
- `npm start` — run the built server over stdio
- `npm run typecheck` — `tsc -p tsconfig.test.json` (src **and** tests, no emit)
- `npm run lint` — ESLint, `--max-warnings=0`
- `npm test` / `npm run test:watch` — Vitest (~0.5 s, no network)
- `npm run check` — typecheck + lint + test. **This is the gate. Run it before calling a task done.** CI runs the same steps plus the build on every pull request.
- `npx @modelcontextprotocol/inspector node dist/index.js` — poke the tools interactively
- `claude mcp add hokuz-image-gen --scope local --transport stdio --env GEMINI_API_KEY="$GEMINI_API_KEY" -- node "$PWD/dist/index.js"` — register with Claude Code, then `/mcp` to confirm

## Critical Gotchas

### 1. `.default()` in a Zod schema controls the published contract

The MCP SDK validates incoming arguments with our Zod schema and passes the **parsed** result to the handler, so defaults are applied by the SDK. More importantly, `.default()` is what makes a field *optional* in the JSON Schema clients see: drop it and the SDK marks the field `required` and rejects every call that omits it (pinned by `src/__tests__/server.test.ts`). Handlers still apply `params.x ?? DEFAULTS.x` as defence in depth; keep doing that, but do not rely on it to make a field optional.

### 2. Gemini image options live in `response_format`, not `generation_config`

`providers/gemini.ts` uses the **Interactions API** (`client.interactions.create`). Aspect ratio, resolution, and MIME type go in `response_format` (an `ImageResponseFormat`). `generation_config.image_config` exists but is `@deprecated` in the SDK — do not use it. (OpenAI is unrelated: `providers/openai.ts` passes `size`, `quality`, `output_format` and `background` as top-level request fields.)

```typescript
response_format: {
  type: "image",
  image_size: "1K",          // API token: "512" | "1K" | "2K" | "4K" (0.5K -> "512")
  mime_type: "image/jpeg",   // JPEG only; see gotcha 3
  aspect_ratio: "16:9",      // OMIT entirely for edit "auto"
}
```

Only `temperature` goes in `generation_config`. The Interactions request has **no safety-settings field**; content moderation uses Google's defaults and there is nothing to configure.

### 3. Gemini models output JPEG only; OpenAI models take the format as given

`response_format.mime_type` accepts only `"image/jpeg"`; the SDK types it as that literal and the API returns HTTP 400 for anything else. That is why the registry's `outputFormats` is `["jpeg"]` for every Gemini model, and why `buildResponseFormat` can cast — validation has already rejected anything else. OpenAI models produce all of `OUTPUT_FORMATS` (`jpeg`, `png`, `webp`); the requested format is sent as `output_format` and decides both the returned image's MIME type and the saved file's extension. Never transcode: the format the provider returns is the format written. PNG files are roughly 16x the size of the same JPEG (verified live). `background: "transparent"` needs `png` or `webp` — with `jpeg` the API returns a hard 400, which is why the registry rejects that pair in-process.

### 4. stdout is the MCP protocol channel

Anything written to stdout corrupts the JSON-RPC stream. Log with `console.error` only. ESLint enforces this (`no-console` allows `error`/`warn`).

### 5. Relative imports end in `.js`

`tsconfig` uses Node16 module resolution, so `import { x } from "./constants.js"` even though the source file is `.ts`. A bare `./constants` import compiles to a runtime "module not found".

### 6. Invalid arguments come back as a tool result, not a protocol error

When the SDK's schema validation rejects a call, the client receives `{ isError: true, content: [{ text: "Input validation error: ..." }] }`, not a JSON-RPC error. Tests and clients should check `isError`, not expect a rejection.

### 7. Options a handler must not default are `.optional()` with **no** schema default

`quality` (OpenAI), `temperature` (Gemini) and edit's `resolution` are published `.optional()` with no `.default()`, which is the opposite of gotcha 1's rule for every shared option — deliberately. `transparent_background` (OpenAI) follows the same rule. The handler passes them through exactly as given and **the provider that owns the option applies its default** (`config.x ?? DEFAULTS.x` in `providers/gemini.ts` / `providers/openai.ts`), so an option reaches the request as a default only where that default is valid. Without this the handler could not tell "the LLM asked for temperature 0.2 on an OpenAI model" from "the SDK filled the default in", and would have to ignore the request silently. The cases:

- `temperature` on an OpenAI model → rejected, naming the Gemini alternative. Gemini applies `DEFAULTS.temperature` when the config carries none.
- `quality` on a Gemini model → rejected, naming the OpenAI models. OpenAI applies `DEFAULTS.quality` when the config carries none.
- edit `resolution` with `aspect_ratio: "auto"` on an OpenAI model → rejected, because the provider derives the pixel size from the ratio and `size: "auto"` would drop the resolution. Generate keeps its `.default("1K")`: it always has a ratio.
- `transparent_background: true` on a Gemini model → rejected, naming the OpenAI models; `false` is what every model already does, so it passes. No default: OpenAI's `background` is `"opaque"` unless the caller asked otherwise.

Give such an option a `.default()` and every call it cannot apply to starts either failing validation or being silently ignored.

## Testing

`npm test` runs every `src/**/*.test.ts` (the suite, about half a second, no network). The suite exists to make the gotchas above and the invariants below fail loudly when broken; it is not a coverage exercise.

- `services/__tests__/file-utils.test.ts` — output path rules (trailing separator, extension replacement, `-N` suffixes in both modes, `~`), the caller-supplied size limit on both the file and URL paths, URL loading via mocked `fetch`.
- `providers/__tests__/gemini.test.ts` — exact Interactions request shape, `aspect_ratio` omitted for `auto`, `parseInteraction` de-dup/fallbacks, API error mapping, `GEMINI_API_KEY` precedence.
- `providers/__tests__/openai.test.ts` — exact `images.generate` request shape, size derivation (spot checks plus an invariant sweep over every ratio x resolution), edit files in order with an explicit MIME type, parse of dimensions and the cost arithmetic, error mapping by status and by `code`, missing-key path.
- `providers/__tests__/index.test.ts` — dispatch to the provider the registry names, and validation before dispatch.
- `tools/__tests__/*.test.ts` — defaults reach the provider (including the per-provider `quality`/`temperature` rule), validation before image loading and before any API call, the per-model input count/size/type rejections, `num_images` loop with summed `usage` and the partial-failure `warning`, files written (with the format's extension), schema-boundary rejections.
- `__tests__/server.test.ts` — tool names, annotations, JSON Schema enums/defaults/`required`, output schema shape, package.json version. `__tests__/constants.test.ts` — validation messages and the "defaults are valid for every model" invariant.

**How tool tests work:** `connectTestClient()` in `src/__tests__/harness.ts` builds the real server via `createServer()` and connects an SDK `Client` over `InMemoryTransport`. Only `providers/index.js`'s `generateImage` / `editImage` are mocked (`vi.mock` with `importOriginal`, so `validateGenerationConfig` stays real). This exercises the SDK's input and output schema validation exactly as a production client would.

**What to test:** the seams — request building, response parsing, path resolution, default application, validation order, and the published schema. Exact assertions on deterministic values; every "must not be called / must not appear" paired with a presence assertion in the same medium.

**What never to test:** Zod's own validation, the MCP SDK's transport, the Google or OpenAI SDK, or what the compiler already checks (`Record<ImageModel, ...>` completeness, enum membership). One test per archetype; do not restate a generate test for edit unless edit's behaviour differs.

**Before a test counts as done, mutate the code it guards and read the failure count.** A test that stays green when its behaviour breaks is deleted, not kept. Restore mutations from a saved copy, never with `git checkout -- <file>` on a dirty tree.

**Manual verification** after changes that touch the API path: `npm run build`, register with an MCP client, run one real generation and one real edit **per provider that changed**, and try one invalid combination (Lite + 2K, or Flare + `temperature`) to see the pre-flight error.

## Adding a Parameter or a Tool

**Parameter:** (1) schema field `z.enum(OPTIONS).default(DEFAULTS.x).describe("...")` — the describe string is read by the LLM, name the options and the default; (2) handler `params.x ?? DEFAULTS.x` into `GenerationConfig`; (3) the provider modules if the request changes; (4) the Args list in **both** `TOOL_DESCRIPTION`s; (5) tests in the same change — the exact request-shape `toEqual` in `providers/__tests__/gemini.test.ts` and `openai.test.ts` will fail until updated, and `server.test.ts` asserts schema defaults; (6) both README parameter tables; (7) `npm run check`.

A parameter only one provider accepts follows gotcha 7 instead: `.optional()` with no `.default()`, a registry axis that says which models take it, a `getUnsupportedModelOptionMessage` branch naming the alternative, and the provider module applying its own default.

**Tool:** `src/schemas/newtool.ts` (`.strict()` input schema, output schema, inferred types) → `src/tools/newtool.ts` (`registerNewTool(server)` with a `hokuz_` name; copy the annotations block and the `catch` → `{ content, structuredContent: { success: false, ... }, isError: true }` pattern from an existing tool) → register in `src/server.ts` and add the banner line in `src/index.ts` → `tools/__tests__/newtool.test.ts` through `connectTestClient()` and the name list in `server.test.ts` → README Tools section → `npm run check`.

## Provider Modules

`providers/index.ts` is the only entry point tools use. It runs `validateGenerationConfig(config)` (which throws `INVALID_MODEL_OPTION` from `getUnsupportedModelOptionMessage`) and then calls `generateImage` / `editImage` on the module named by `IMAGE_MODEL_CAPABILITIES[config.model].provider`. One table, `const PROVIDERS: Record<Provider, ProviderModule>`, is the whole dispatch: every module exports `label`, `hasApiKey()`, `generateImage` and `editImage`, and neither validates. `providerLabel(p)` (the startup banner) and `enabledProviders()` (which `index.ts` boots on) are lookups over the same table, so adding a provider is a `Provider` union member plus one table entry. Each module also applies its own defaults for the options it owns (gotcha 7).

### Gemini (`providers/gemini.ts`)

One singleton `GoogleGenAI` client (key resolved `GEMINI_API_KEY` → `GOOGLE_API_KEY`). Generate sends `input: prompt` (a string); edit sends `input: [...imageBlocks, { type: "text", text: prompt }]` with images first so "first/second image" prompts resolve in order. Both use `response_format: buildResponseFormat(config)` (gotcha 2) and `generation_config: { temperature }`.

**Response parsing** (`parseInteraction`, exported): reads `interaction.output_image` first, then scans `steps[]` of type `model_output` for additional `image`/`text` blocks (de-duplicated by data), falls back to `output_text` for the description, and throws `CONTENT_BLOCKED` if no image was found.

**Error mapping** (`handleApiError`): `McpError`s we raised pass through unchanged; otherwise message heuristics map 429/"rate limit" → `API_RATE_LIMIT`, 401/403/"api key" → `MISSING_API_KEY`, "blocked"/"safety" → `CONTENT_BLOCKED`, else `API_ERROR`.

### OpenAI (`providers/openai.ts`)

One singleton `OpenAI` client from `OPENAI_API_KEY`. Both calls send `{ model, prompt, n: 1, size, quality, output_format, background }`, where `background` is `"transparent"` only when the caller asked and `"opaque"` otherwise (never `"auto"`: the cost and the alpha channel must be predictable); edit adds `image`, an array of `toFile(Buffer.from(data, "base64"), "image-N.<ext>", { type: mimeType })` in input order. **The explicit `{ type }` is load-bearing**: a buffer without it uploads as `application/octet-stream` and the API rejects it. There is no `input_fidelity` — the SDK's doc comment claims it exists, but every current GPT Image model rejects it (`invalid_input_fidelity_model`), so it is not a parameter. The Images API has no `temperature`.

**Size derivation** (`openaiSize`, exported): OpenAI takes a free-form `WIDTHxHEIGHT`, not a resolution token, so the size is `sqrt(area * w / h) x sqrt(area * h / w)` with each edge rounded to a multiple of 16, where `area` is 1024² for `1K` and 2048² for `2K` (the same "area" reading of the tokens Gemini uses, which is why it does not reproduce OpenAI's 1536x1024 presets). No aspect ratio (edit `auto`) sends `size: "auto"` and the provider picks. The API's own rules — both edges ÷16, aspect within 1:3..3:1, edge ≤ 3840, 655,360..8,294,400 pixels — are swept in the test.

**Response parsing** (`parseImagesResponse`, exported, and called **outside** the try/catch so its errors are never relabelled as request failures): `data[].b64_json` → images, `size` → `width`/`height` (absent only when the size cannot be parsed; a `size: "auto"` request comes back with the real `WxH`), `usage` → `{ inputTokens, outputTokens, estimatedCostUsd }` where the cost is `(text_tokens·5 + image_tokens·8 + output_tokens·30) / 1e6` from `OPENAI_PRICE_PER_MILLION_TOKENS`. A `usage` without `input_tokens_details` yields no report rather than dropping the image. No image → `API_ERROR`.

**Error mapping** (`handleApiError`): `McpError` pass-through, then `instanceof APIError` with `code === "moderation_blocked"` → `CONTENT_BLOCKED` (message carries the stage and categories), then `status` 401 → `MISSING_API_KEY`, 403/404 → `API_ERROR`, 429 → `API_RATE_LIMIT`, other 4xx → `API_ERROR`, else a retryable `API_ERROR` (status or `network`). A non-`APIError` — only the SDK call is wrapped — is a retryable `API_ERROR` that quotes the message and claims nothing about its cause.

## File Utility Patterns

`resolveOutputPath(outputPath, format, index)`:

```
"~/images/" or an existing directory  → directory mode: create if missing,
                                         image-YYYY-MM-DD-HHmmss-SSS[-N].<ext>
"~/images/foo.png"                     → file mode: extension replaced → foo.jpg (jpeg)
"~/images/foo"                         → file mode: extension appended → foo.jpg (jpeg)
A TRAILING SEPARATOR always means directory, even if it does not exist yet.
index ≥ 1 appends -2, -3, … in both modes (this is the same-millisecond collision guard).
```

`loadImage(pathOrUrl, maxBytes)` dispatches on `http(s)://` to `fetch` (MIME from `content-type`) or reads the file (MIME from extension, default `image/png`). Both enforce `maxBytes`, which the edit tool passes from the selected model's `maxInputImageBytes` (Gemini 7 MB, OpenAI 50 MB). The loaded MIME type is then checked against the model's `inputMimeTypes` — that check needs the bytes, so it is the one validation that runs after loading, still before any API call.

## Error Handling

All failures become `McpError(type, message, details?)` with an actionable message that starts with `Error:`. Handlers catch everything and return `{ content: [{ type: "text", text }], structuredContent: { success: false, images: [], error }, isError: true }`. Validation (`validateGenerationConfig`, including the input-image count) runs before any API call and, in edit, before any image is loaded; `getUnsupportedInputImageMessage` then runs per image as it is loaded.

## Constants Reference (`src/constants.ts`)

- `IMAGE_MODELS`: `gemini-3.1-flash-image` (default, Nano Banana 2), `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`. Exact IDs; do not guess new ones.
- `IMAGE_MODEL_CAPABILITIES`: every field drives behaviour — `provider`, `resolutions`, `aspectRatios`, `outputFormats`, `qualities` (empty = the option is rejected), `supportsTemperature`, `supportsTransparentBackground`, `maxInputImages`, `maxInputImageBytes`, `inputMimeTypes`. Adding a field that gates nothing is how the old dead `supports*` flags happened; don't.
- `ASPECT_RATIOS`: 10 base + `1:4`, `4:1`, `1:8`, `8:1` (flash only; OpenAI models take the base ten). `RESOLUTIONS`: `0.5K`, `1K`, `2K`, `4K` (`0.5K` → Gemini API `"512"`; Lite is `1K` only; Pro has no `0.5K`; OpenAI models are `1K`/`2K`). `QUALITIES`: `low`, `medium`, `high`, `xhigh`, `max` — OpenAI only, and `auto` is deliberately not exposed because its cost is unknowable. `OUTPUT_FORMATS`: `jpeg`, `png`, `webp` (Gemini models take `jpeg` only).
- `OPENAI_PRICE_PER_MILLION_TOKENS`: `{ textInput: 5, imageInput: 8, imageOutput: 30 }`, hand-maintained, the only input to the reported cost estimate.
- `LIMITS`: 16 input images (the schema bound: the largest per-model limit), 4 output images, temperature 0–2. Per-model input limits and types live in the registry. `DEFAULTS`: flash, `1:1`, `1K`, jpeg, 1 image, temperature 1.0 (Gemini), quality `medium` (OpenAI) — pinned as a valid combination for every model by test.

`num_images > 1` is **repeated independent requests**, not an API count parameter (OpenAI's `n` is billed the same way and would return one aggregate `usage`). The loop stops early on a failure if at least one image was collected; the shortfall and the failing request's message go into `warning`, in both the response text and `structuredContent`. `usage` is summed across the iterations. Edit `aspect_ratio: "auto"` means `config.aspectRatio` is `undefined` and `aspect_ratio` is omitted from the request; never coerce it to `1:1`.

### Adding or updating a model

1. Add the exact ID to `IMAGE_MODELS` and an entry to `IMAGE_MODEL_CAPABILITIES`.
2. New resolution/aspect tokens go in `RESOLUTIONS` / `ASPECT_RATIOS` (a new resolution also needs its Gemini `image_size` token in `IMAGE_SIZE_API_VALUES` in `providers/gemini.ts`, and its pixel area in `RESOLUTION_PIXEL_AREA` in `providers/openai.ts`).
3. Smoke-test the ID against that provider's API; IDs are not guaranteed stable.
4. If the model belongs to a new provider, add it to `Provider`, write `providers/<name>.ts` exporting `label`, `hasApiKey`, `generateImage` and `editImage`, add it to the `PROVIDERS` table in `providers/index.ts`, and add the key to `ENV_VARS`.
5. Update the model enum assertion in `server.test.ts`, the model paragraphs in both `TOOL_DESCRIPTION`s and both schemas' `model.describe()`, and the README model and cost tables. Speed/cost figures are hand-maintained in those four places.

## Claude's Operating Guidelines

**Show Before You Code** — when a change alters anything the calling LLM reads or a user sees: a `TOOL_DESCRIPTION`, a schema `.describe()`, the JSON Schema shape (new field, changed default, changed `required`), response text, or an error message. Show the before/after string and confirm before implementing. Internal refactors, new tests, and doc-only edits do not trigger this.

**Reasoning-First** — every code change:
1. Reads the existing tool, schema, and service first; both tools share one structure, so a new behaviour usually has a home already.
2. States *why* it is needed and *how* it fits the three-file tool pattern.
3. Passes the **deletion test** before adding an abstraction (see Code Quality).
4. Ships with its tests. A change without a test that would fail on regression is incomplete.
5. Ends with `npm run check` green.

**Review battery.** Before a PR, or after any phase that touches schemas, descriptions, `file-utils.ts`, the request path, or tests, run `/deep-review` (scope: `staged` | `unstaged` | `branch`). It picks 1-4 lenses from `.claude/agents/review-*.md` — silent-failures, tool-contract, test-fidelity, input-safety, simplicity — evaluates their findings, and produces an action plan; you own the verdict, not the lenses. `review-falsifier` runs the built server against the real API and costs money: `--falsify` or an explicit ask only. After writing tests, run `/test-reflect`.

**Keep the four hand-maintained surfaces in sync** when a task adds a parameter, model, or tool or changes a documented behaviour: this file, the README tables, both `TOOL_DESCRIPTION`s, and the schema `.describe()` strings — plus any review lens in `.claude/agents/` that cites the changed fact. Stale instruction files have caused real errors.

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
