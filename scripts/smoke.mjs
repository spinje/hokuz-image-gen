#!/usr/bin/env node
/**
 * Paid live check of the built server over stdio: `npm run build && npm run smoke`.
 * One cheap generate and edit per provider whose key is set, a Gemini edit that
 * matches a portrait input's shape, one transparent PNG, and the pre-flight
 * rejections that must cost nothing (6 paid calls, ~13c).
 * Keys are passed to the child process and never printed. This is a CLI, not
 * the server, so stdout is its report channel.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "dist", "index.js");
const HAS_GEMINI = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let failures = 0;
let costUsd = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, run) {
  const started = Date.now();
  try {
    const note = await run();
    console.log(`ok   ${name} (${Date.now() - started}ms) ${note ?? ""}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} (${Date.now() - started}ms) ${error.message}`);
  }
}

/** Call a tool and require a successful result; accumulate any reported cost. */
async function callOk(client, tool, args) {
  const result = await client.callTool({ name: tool, arguments: args });
  assert(!result.isError, `tool returned an error: ${result.content?.[0]?.text}`);
  const output = result.structuredContent;
  assert(output?.status === "complete", "structuredContent.status is not complete");
  // Every smoke call names its model; the result must report the one used.
  assert(output.settings?.model === args.model, `settings.model is ${output.settings?.model}, expected ${args.model}`);
  if (output.usage) costUsd += output.usage.estimated_cost_usd;
  return output;
}

/**
 * A real, decodable RGB PNG: the top half sky blue, the bottom half green. Built
 * here so the match_input step needs no paid generate and no image library.
 */
function portraitPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit truecolour, no interlace
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0, then RGB
    const [r, g, b] = y < height / 2 ? [135, 190, 235] : [70, 140, 60];
    for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function assertJpeg(file) {
  const bytes = await fs.readFile(file);
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, `${file} is not a JPEG`);
}

async function main() {
  await fs.access(SERVER).catch(() => {
    throw new Error(`Error: ${SERVER} is missing. Run 'npm run build' first.`);
  });
  if (!HAS_GEMINI && !HAS_OPENAI) {
    throw new Error(
      "Error: no provider key in the environment. Set GEMINI_API_KEY (or GOOGLE_API_KEY) and/or OPENAI_API_KEY and run again."
    );
  }
  if (!HAS_GEMINI) console.log("skip Gemini steps - no GEMINI_API_KEY/GOOGLE_API_KEY");
  if (!HAS_OPENAI) console.log("skip OpenAI steps - no OPENAI_API_KEY");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-smoke-"));
  console.log(`Writing into ${dir}`);

  const client = new Client({ name: "hokuz-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: process.env,
  });
  await client.connect(transport);

  let geminiImage;
  if (HAS_GEMINI) {
    await step("Gemini Lite generate 1K 4:3", async () => {
      const out = await callOk(client, "hokuz_generate_image", {
        prompt: "A single red apple on a white table, studio lighting",
        output_path: path.join(dir, "gemini.jpg"),
        model: "gemini-3.1-flash-lite-image",
        resolution: "1K",
        aspect_ratio: "4:3",
      });
      const [image] = out.images;
      const size = `${image.width}x${image.height}`;
      assert(size === "1200x896", `expected 1200x896, got ${size}`);
      // The measured Gemini grid (GEMINI_OUTPUT_SIZE_1K) against a live delivery.
      assert(out.settings.expected_size === size, `settings.expected_size is ${out.settings.expected_size}, delivered ${size}`);
      assert(
        out.usage?.estimated_cost_usd === 0.0336,
        `expected an estimated cost of $0.0336, got ${out.usage?.estimated_cost_usd}`
      );
      // The only live observation of which basis each provider reports.
      assert(
        out.usage?.cost_basis === "per_image",
        `expected cost_basis per_image, got ${out.usage?.cost_basis}`
      );
      geminiImage = image.path;
      await assertJpeg(geminiImage);
      return `${geminiImage} ${size} $${out.usage.estimated_cost_usd.toFixed(4)}`;
    });

    await step("Gemini Lite edit, aspect_ratio omitted", async () => {
      assert(geminiImage, "the generate step produced no image to edit");
      const out = await callOk(client, "hokuz_edit_image", {
        prompt: "Make the apple green",
        image_paths: [geminiImage],
        output_path: path.join(dir, "gemini-edit.jpg"),
        model: "gemini-3.1-flash-lite-image",
      });
      const [image] = out.images;
      assert(image.width > 0 && image.height > 0, "no pixel size reported");
      assert(out.usage?.estimated_cost_usd > 0, "no estimated cost reported");
      await assertJpeg(image.path);
      return `${image.path} ${image.width}x${image.height}`;
    });

    await step("Gemini Lite edit, match_input on a 720x1000 portrait", async () => {
      const portrait = path.join(dir, "portrait.png");
      await fs.writeFile(portrait, portraitPng(720, 1000));
      const out = await callOk(client, "hokuz_edit_image", {
        prompt: "Add a small white cloud in the sky",
        image_paths: [portrait],
        output_path: path.join(dir, "gemini-match.jpg"),
        model: "gemini-3.1-flash-lite-image",
        aspect_ratio: "match_input",
      });
      // 0.72 is nearest 3:4; the measured Gemini 1K size for 3:4 is 896x1200.
      assert(out.settings.aspect_ratio === "3:4", `settings.aspect_ratio is ${out.settings.aspect_ratio}, expected 3:4`);
      assert(out.settings.matched_input_size === "720x1000", `settings.matched_input_size is ${out.settings.matched_input_size}`);
      // 0.72 is 4% narrower than 3:4.
      assert(out.settings.match_error_pct === -4, `settings.match_error_pct is ${out.settings.match_error_pct}, expected -4`);
      const [image] = out.images;
      const size = `${image.width}x${image.height}`;
      assert(out.settings.expected_size === "896x1200", `settings.expected_size is ${out.settings.expected_size}`);
      assert(size === out.settings.expected_size, `expected ${out.settings.expected_size}, delivered ${size}`);
      await assertJpeg(image.path);
      return `${image.path} ${size}`;
    });
  }

  let flareImage;
  if (HAS_OPENAI) {
    await step("Flare generate low 16:9", async () => {
      const out = await callOk(client, "hokuz_generate_image", {
        prompt: "A quiet harbour at dawn",
        output_path: path.join(dir, "flare.jpg"),
        model: "gpt-image-2.5-flare",
        quality: "low",
        aspect_ratio: "16:9",
      });
      const [image] = out.images;
      const size = `${image.width}x${image.height}`;
      assert(size === "1360x768", `expected 1360x768, got ${size}`);
      assert(out.settings.expected_size === size, `settings.expected_size is ${out.settings.expected_size}, delivered ${size}`);
      assert(out.usage?.estimated_cost_usd > 0, "no estimated cost reported");
      // The only live observation that this provider prices by token.
      assert(
        out.usage?.cost_basis === "tokens",
        `expected cost_basis tokens, got ${out.usage?.cost_basis}`
      );
      flareImage = image.path;
      await assertJpeg(flareImage);
      return `${size} $${out.usage.estimated_cost_usd.toFixed(4)}`;
    });

    await step("Flare edit low, aspect_ratio omitted", async () => {
      assert(flareImage, "the generate step produced no image to edit");
      const out = await callOk(client, "hokuz_edit_image", {
        prompt: "Add a lighthouse on the far pier",
        image_paths: [flareImage],
        output_path: path.join(dir, "flare-edit.jpg"),
        model: "gpt-image-2.5-flare",
        quality: "low",
      });
      const [image] = out.images;
      assert(image.width > 0 && image.height > 0, "no pixel size reported");
      return `${image.path} ${image.width}x${image.height}`;
    });

    await step("Flare generate low, .png path, transparent", async () => {
      const out = await callOk(client, "hokuz_generate_image", {
        prompt: "A flat sticker of a smiling star",
        output_path: path.join(dir, "star.png"),
        model: "gpt-image-2.5-flare",
        quality: "low",
        transparent_background: true,
      });
      const file = out.images[0].path;
      assert(file.endsWith(".png"), `expected a .png file, got ${file}`);
      const bytes = await fs.readFile(file);
      assert(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`);
      // IHDR colour type: 6 is truecolour with alpha.
      assert(bytes[25] === 6, `IHDR colour type is ${bytes[25]}, expected 6 (RGBA)`);
      return file;
    });
  }

  const missing = Array.from({ length: 15 }, (_, i) => path.join(dir, `nope-${i}.png`));
  // A HEIC's size has no cheap header, so match_input rejects it after loading, before any request.
  const heic = path.join(dir, "photo.heic");
  await fs.writeFile(heic, "not really a heic");
  const rejections = [
    ["Lite + 2K", "hokuz_generate_image", { model: "gemini-3.1-flash-lite-image", resolution: "2K" }],
    ["Flare + 4K", "hokuz_generate_image", { model: "gpt-image-2.5-flare", resolution: "4K" }],
    ["Flare + 1:4", "hokuz_generate_image", { model: "gpt-image-2.5-flare", aspect_ratio: "1:4" }],
    ["Gemini + quality", "hokuz_generate_image", { quality: "low" }],
    ["Flare + temperature", "hokuz_generate_image", { model: "gpt-image-2.5-flare", temperature: 0.5 }],
    ["Flare + transparent + jpeg", "hokuz_generate_image", { model: "gpt-image-2.5-flare", transparent_background: true, output_format: "jpeg" }],
    ["Gemini edit with 15 images", "hokuz_edit_image", { image_paths: missing }],
  ];

  for (const [name, tool, args] of rejections) {
    await step(`reject ${name}`, async () => {
      const started = Date.now();
      const result = await client.callTool({
        name: tool,
        arguments: { prompt: "a placeholder prompt", output_path: dir, ...args },
      });
      const elapsed = Date.now() - started;
      const text = result.content?.[0]?.text ?? "";
      assert(result.isError === true, `expected an error result, got: ${text}`);
      assert(result.structuredContent?.status === "failed" && result.structuredContent?.issue?.next_step, `missing failure/recovery information: ${text}`);
      assert(elapsed < 1000, `took ${elapsed}ms, so it was not rejected pre-flight`);
      return text.slice(0, 90);
    });
  }

  // Needs the Gemini key: without it the call fails on MISSING_API_KEY before the image loads.
  if (HAS_GEMINI) {
    await step("reject Gemini edit match_input on HEIC", async () => {
      const started = Date.now();
      const result = await client.callTool({
        name: "hokuz_edit_image",
        arguments: { prompt: "a placeholder prompt", output_path: dir, image_paths: [heic], aspect_ratio: "match_input" },
      });
      const elapsed = Date.now() - started;
      const text = result.content?.[0]?.text ?? "";
      const issue = result.structuredContent?.issue;
      assert(result.isError === true, `expected an error result, got: ${text}`);
      assert(issue?.code === "INVALID_IMAGE_PATH", `expected issue.code INVALID_IMAGE_PATH, got ${issue?.code}: ${text}`);
      assert(issue.message.includes("match_input"), `the message does not name match_input: ${issue.message}`);
      assert(elapsed < 1000, `took ${elapsed}ms, so it was not rejected pre-flight`);
      return text.slice(0, 90);
    });
  }

  await client.close();

  // The only check that ties our Gemini error mapping to the real SDK. The
  // classification duck-types `status` off an internal error class, so a bump
  // that renames or re-types it leaves every unit test green while every live
  // failure degrades to a generic retry. A rejected key is free.
  if (HAS_GEMINI) {
    await step("live: a rejected Gemini key maps to MISSING_API_KEY", async () => {
      const badKeyClient = new Client({ name: "hokuz-smoke-badkey", version: "0.0.0" });
      const badKeyTransport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env, GEMINI_API_KEY: "not-a-real-key", GOOGLE_API_KEY: "" },
      });
      await badKeyClient.connect(badKeyTransport);
      try {
        const result = await badKeyClient.callTool({
          name: "hokuz_generate_image",
          arguments: {
            prompt: "a placeholder prompt",
            output_path: dir,
            model: "gemini-3.1-flash-lite-image",
          },
        });
        const text = result.content?.[0]?.text ?? "";
        assert(result.isError === true, `expected an error result, got: ${text}`);
        assert(
          result.structuredContent?.issue?.code === "MISSING_API_KEY",
          `expected issue.code MISSING_API_KEY, got ${result.structuredContent?.issue?.code}: ${text}`
        );
        return text.slice(0, 90);
      } finally {
        await badKeyClient.close();
      }
    });
  }

  console.log(`Estimated cost: $${costUsd.toFixed(4)}`);
  console.log(failures === 0 ? `All steps passed. Files in ${dir}` : `${failures} step(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
