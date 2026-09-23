import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImagePreview } from "../image-preview.js";

// Exercise our control flow without loading a native decoder or large images.
const decoder = vi.hoisted(() => ({
  open: vi.fn(), metadata: vi.fn(), stats: vi.fn(), resize: vi.fn(), toBuffer: vi.fn(),
}));
vi.mock("sharp", () => ({ default: decoder.open }));

// Only the signature is consumed by our code; the decoder supplies metadata.
const input = Buffer.from([0xff, 0xd8, 0xff]).toString("base64");
const metadata = { format: "jpeg", depth: "uchar", width: 2, height: 1, hasAlpha: false };
const encoded = { data: Buffer.from("derived jpeg"), info: { width: 2, height: 1 } };

beforeEach(() => {
  vi.resetAllMocks();
  decoder.resize.mockReturnThis();
  decoder.open.mockImplementation(() => ({
    metadata: decoder.metadata, stats: decoder.stats, resize: decoder.resize, toBuffer: decoder.toBuffer,
    ...Object.fromEntries(["timeout", "rotate", "toColourspace", "ensureAlpha", "raw", "flatten", "composite", "jpeg"]
      .map(method => [method, vi.fn().mockReturnThis()])),
  }));
  decoder.metadata.mockResolvedValue(metadata);
  decoder.stats.mockResolvedValue({ channels: [{ min: 0, max: 255 }] });
  decoder.toBuffer.mockResolvedValue(encoded);
});

describe("preview dimension limits", () => {
  it.each([[5001, 5000], [16385, 1], [1, 16385]])("rejects %ix%i before pixel processing", async (width, height) => {
    decoder.metadata.mockResolvedValue({ ...metadata, width, height, hasAlpha: true });
    await expect(createImagePreview(input, "image/jpeg")).rejects.toThrow("pixel or edge limit");
    expect(decoder.metadata).toHaveBeenCalledTimes(1);
    expect(decoder.stats).not.toHaveBeenCalled();
    expect(decoder.resize).not.toHaveBeenCalled();
    expect(decoder.toBuffer).not.toHaveBeenCalled();
  });

  it.each([[5000, 5000], [16384, 1], [1, 16384]])("accepts %ix%i at the boundary", async (width, height) => {
    decoder.metadata.mockResolvedValue({ ...metadata, width, height });
    await expect(createImagePreview(input, "image/jpeg")).resolves.toMatchObject({ data: encoded.data.toString("base64") });
    expect(decoder.resize).toHaveBeenCalledTimes(1);
    expect(decoder.toBuffer).toHaveBeenCalledTimes(2);
    expect(decoder.open).toHaveBeenCalledWith(Buffer.from(input, "base64"), expect.objectContaining({ limitInputPixels: 25_000_000 }));
  });
});
