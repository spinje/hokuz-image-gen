import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { createImagePreview } from "../image-preview.js";

const preview = (bytes: Buffer, mime = "image/png") => createImagePreview(bytes.toString("base64"), mime);
const pixel = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe("bounded image preview", () => {
  it("measures original alpha before downsampling and composites white and navy", async () => {
    const pixels = Buffer.alloc(1024 * 1024 * 4, 255);
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 512; x++) pixels[(y * 1024 + x) * 4 + 3] = 128;
    // This one transparent pixel disappears on downsampling; original min stays 0.
    pixels[3] = 0;
    const bytes = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
    const result = await preview(bytes);
    expect(result).toMatchObject({ width: 1024, height: 512, background: "white_and_navy", alpha: { has_channel: true, min: 0, max: 255 } });
    const decoded = await sharp(Buffer.from(result.data, "base64")).removeAlpha().raw().toBuffer();
    const white = pixel(decoded, 1024, 128, 256);
    const navy = pixel(decoded, 1024, 640, 256);
    expect(white).toEqual([255, 255, 255]);
    for (const [index, expected] of [138, 148, 158].entries()) expect(Math.abs(navy[index] - expected)).toBeLessThanOrEqual(3);
    const resized = await sharp(bytes).resize(512, 512).png().toBuffer();
    expect((await sharp(resized).stats()).channels[3].min).toBeGreaterThan(0);
  });

  it("treats an all-opaque alpha channel as opaque and keeps extreme-aspect edges", async () => {
    const raw = Buffer.alloc(1024 * 128 * 4, 255);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 1024; x++) {
      const i = (y * 1024 + x) * 4;
      raw[i] = x < 512 ? 255 : 0; raw[i + 1] = 0; raw[i + 2] = x < 512 ? 0 : 255;
    }
    const bytes = await sharp(raw, { raw: { width: 1024, height: 128, channels: 4 } }).png().toBuffer();
    const result = await preview(bytes);
    expect(result).toMatchObject({ width: 512, height: 64, background: "original", alpha: { has_channel: true, min: 255, max: 255 } });
    const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer();
    expect(pixel(decoded, 512, 0, 32)[0]).toBeGreaterThan(245);
    expect(pixel(decoded, 512, 511, 32)[2]).toBeGreaterThan(245);
  });

  it("reads gray+alpha from the last channel and supports lossless WebP alpha", async () => {
    const source = sharp(Buffer.from([50, 0, 100, 128, 150, 255]), { raw: { width: 3, height: 1, channels: 2 } });
    const gray = await source.clone().toColourspace("b-w").png().toBuffer();
    expect((await sharp(gray).metadata()).channels).toBe(2);
    expect((await preview(gray)).alpha).toEqual({ has_channel: true, min: 0, max: 255 });
    const webp = await source.clone().webp({ lossless: true }).toBuffer();
    expect((await preview(webp, "image/webp")).alpha).toEqual({ has_channel: true, min: 0, max: 255 });
  });

  it("rejects byte, pixel and edge overflow without requiring large compressed fixtures", async () => {
    await expect(createImagePreview("A".repeat(4 * Math.ceil(32 * 1024 * 1024 / 3) + 1), "image/jpeg")).rejects.toThrow("32 MiB");
    for (const [width, height] of [[5001, 5000], [16385, 1]]) {
      const bytes = await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
      await expect(preview(bytes)).rejects.toThrow(/pixel|edge/i);
    }
  });

  it("rejects signature mismatch, non-8-bit pixels and animated output", async () => {
    const source = sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } });
    const png = await source.clone().png().toBuffer();
    await expect(preview(png, "image/jpeg")).rejects.toThrow("signature or MIME");
    await expect(preview(Buffer.from('<svg width="8" height="8"></svg>'))).rejects.toThrow("signature or MIME");
    const depth16 = await source.clone().toColourspace("rgb16").png().toBuffer();
    await expect(preview(depth16)).rejects.toThrow("single-frame 8-bit");
    const animated = await sharp([await source.clone().png().toBuffer(), await source.clone().negate().png().toBuffer()], { join: { animated: true } }).webp().toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    // Valid two-frame 1x1 APNG: opaque red first frame, transparent blue second.
    // Sharp reports no pages for it, so the byte-level acTL check is essential.
    const apng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABFmZEFUAAAAAnicY2Bg+M8AAAIDAQA75FIUAAAAAElFTkSuQmCC", "base64");
    expect((await sharp(apng).stats()).channels[3].min).toBe(255);
    await expect(preview(apng)).rejects.toThrow("single-frame 8-bit");
    await expect(preview(animated, "image/webp")).rejects.toThrow("single-frame 8-bit");
  });

  it("omits an encoded preview that exceeds the payload limit", async () => {
    const raw = Buffer.alloc(512 * 512 * 4);
    let seed = 1;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = i % 4 === 3 ? 254 : seed >>> 24;
    }
    const bytes = await sharp(raw, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
    await expect(preview(bytes)).rejects.toThrow("200 KiB");
  });
});
