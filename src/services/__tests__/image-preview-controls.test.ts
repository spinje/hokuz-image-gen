import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImagePreview } from "../image-preview.js";
import { ErrorType } from "../../types.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("preview stage cancellation", () => {
  it("rejects cancellation before inspecting input", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createImagePreview("invalid", "image/jpeg", controller.signal)).rejects.toMatchObject({ issue: expect.objectContaining({ code: ErrorType.REQUEST_CANCELLED }) });
    expect(decoder.open).not.toHaveBeenCalled();
    await expect(createImagePreview(input, "image/jpeg")).resolves.toMatchObject({ background: "original" });
    expect(decoder.open).toHaveBeenCalled();
  });

  it("checks cancellation after awaiting the decoder import", async () => {
    const controller = new AbortController();
    const result = createImagePreview(input, "image/jpeg", controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ issue: expect.objectContaining({ code: ErrorType.REQUEST_CANCELLED }) });
    expect(decoder.open).not.toHaveBeenCalled();
    await expect(createImagePreview(input, "image/jpeg")).resolves.toMatchObject({ background: "original" });
    expect(decoder.open).toHaveBeenCalled();
  });

  const stages = ["metadata", "statistics", "thumbnail", "white panel", "navy panel", "encoding"];
  it.each(stages.map((stage, index) => [stage, index] as const))("waits for active %s then stops subsequent work", async (_stage, index) => {
    const entered = deferred<void>(); const finish = deferred<void>();
    const completed: string[] = [];
    const values = [
      { ...metadata, hasAlpha: true }, { channels: [{ min: 0, max: 255 }] },
      encoded, Buffer.from("white"), Buffer.from("navy"), encoded,
    ];
    const run = (i: number) => async () => {
      completed.push(stages[i]);
      if (i === index) { entered.resolve(); await finish.promise; }
      return values[i];
    };
    decoder.metadata.mockImplementationOnce(run(0));
    decoder.stats.mockImplementationOnce(run(1));
    for (let i = 2; i < stages.length; i++) decoder.toBuffer.mockImplementationOnce(run(i));
    const controller = new AbortController();
    const result = createImagePreview(input, "image/jpeg", controller.signal);
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(result).rejects.toMatchObject({ issue: expect.objectContaining({ code: ErrorType.REQUEST_CANCELLED }) });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    await rejected;
    expect(completed).toEqual(stages.slice(0, index + 1));
  });

  it("finishes all transparent preview stages without cancellation", async () => {
    decoder.metadata.mockResolvedValue({ ...metadata, hasAlpha: true });
    decoder.toBuffer.mockResolvedValueOnce(encoded).mockResolvedValueOnce(Buffer.from("white"))
      .mockResolvedValueOnce(Buffer.from("navy")).mockResolvedValueOnce(encoded);
    await expect(createImagePreview(input, "image/jpeg", new AbortController().signal)).resolves.toMatchObject({
      background: "white_and_navy", alpha: { has_channel: true, min: 0, max: 255 },
    });
    expect(decoder.metadata).toHaveBeenCalledTimes(1);
    expect(decoder.stats).toHaveBeenCalledTimes(1);
    expect(decoder.toBuffer).toHaveBeenCalledTimes(4);
  });
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
