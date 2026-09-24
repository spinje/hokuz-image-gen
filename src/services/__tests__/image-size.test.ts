import { describe, expect, it } from "vitest";
import { displayedPixelSize, jpegPixelSize } from "../image-size.js";
import { pngHeader as png } from "../../__tests__/fixtures.js";

/** A JPEG header: SOI, optional APP1, a DHT (0xC4, inside the SOF range), then SOF. */
function jpeg(width: number, height: number, app1?: Buffer): Buffer {
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x11, 0x22, 0x33]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9);
  const segments = app1 ? [app1] : [];
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, dht, sof, Buffer.alloc(16)]);
}

/** An APP1 segment with one IFD0 entry: the orientation tag, in either byte order. */
function exifApp1(orientation: number, byteOrder: "II" | "MM" = "MM"): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const le = byteOrder === "II";
  const u16 = (value: number, at: number) => (le ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const u32 = (value: number, at: number) => (le ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(byteOrder, 0, "latin1");
  u16(42, 2);
  u32(8, 4); // IFD0 right after the header
  u16(1, 8); // one entry
  u16(0x0112, 10); // Orientation
  u16(3, 12); // SHORT
  u32(1, 14); // count
  u16(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** RIFF/WEBP with one chunk whose first bytes are `data`. */
function webp(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(12 + data.length, 4);
  head.write("WEBP", 8, "latin1");
  head.write(fourcc, 12, "latin1");
  head.writeUInt32LE(data.length, 16);
  return Buffer.concat([head, data]);
}

function vp8(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3); // key frame start code after the 3-byte frame tag
  data.writeUInt16LE(width | 0x4000, 6); // scale bits must be masked off
  data.writeUInt16LE(height, 8);
  return webp("VP8 ", data);
}

function vp8l(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14); // 28 bits, little-endian
  const data = Buffer.alloc(10);
  data[0] = 0x2f;
  data.writeUInt32LE(bits >>> 0, 1);
  return webp("VP8L", data);
}

function vp8x(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webp("VP8X", data);
}

describe("displayedPixelSize", () => {
  it("reads PNG, GIF and all three WebP chunk kinds from their headers", () => {
    expect(displayedPixelSize(png(1200, 896))).toEqual({ width: 1200, height: 896 });
    expect(displayedPixelSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(displayedPixelSize(vp8(1000, 750))).toEqual({ width: 1000, height: 750 });
    // 16383 x 16383 exercises every bit of both 14-bit fields.
    expect(displayedPixelSize(vp8l(16383, 16383))).toEqual({ width: 16383, height: 16383 });
    expect(displayedPixelSize(vp8l(721, 1283))).toEqual({ width: 721, height: 1283 });
    expect(displayedPixelSize(vp8x(3000, 70000))).toEqual({ width: 3000, height: 70000 });
  });

  it("reads a JPEG past a DHT, and swaps the edges for EXIF orientations 5-8 only", () => {
    expect(displayedPixelSize(jpeg(1200, 896))).toEqual({ width: 1200, height: 896 });
    for (const orientation of [1, 2, 3, 4]) {
      expect(displayedPixelSize(jpeg(1200, 896, exifApp1(orientation)))).toEqual({ width: 1200, height: 896 });
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(displayedPixelSize(jpeg(1200, 896, exifApp1(orientation)))).toEqual({ width: 896, height: 1200 });
    }
    expect(displayedPixelSize(jpeg(1200, 896, exifApp1(6, "II")))).toEqual({ width: 896, height: 1200 });
    // A SOF's own length field is not needed to read its size (parity with the walker
    // Gemini output was measured by before this module): a bogus 0 still reads.
    const zeroLength = jpeg(1200, 896);
    zeroLength.writeUInt16BE(0, zeroLength.length - 16 - 11 + 2);
    expect(displayedPixelSize(zeroLength)).toEqual({ width: 1200, height: 896 });
    // The stored size Gemini output is measured by ignores orientation.
    expect(jpegPixelSize(jpeg(1200, 896, exifApp1(6)))).toEqual({ width: 1200, height: 896 });
  });

  it("returns undefined for HEIC, garbage, zero edges and every truncation", () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(32)]);
    expect(displayedPixelSize(heic)).toBeUndefined();
    expect(displayedPixelSize(Buffer.from("not an image at all, just some bytes"))).toBeUndefined();
    expect(displayedPixelSize(Buffer.alloc(0))).toBeUndefined();
    expect(displayedPixelSize(png(0, 896))).toBeUndefined();
    expect(displayedPixelSize(gif(640, 0))).toBeUndefined();

    // Every prefix that ends before the size field reads as nothing, never throws;
    // the whole header reads.
    const cases: Array<[Buffer, number]> = [
      [png(1200, 896), 24], [gif(640, 480), 10], [vp8(1000, 750), 30], [vp8l(721, 1283), 25],
      [vp8x(3000, 700), 30], [jpeg(1200, 896, exifApp1(6)), 0],
    ];
    for (const [full, sizeFieldEnd] of cases) {
      // The JPEG's SOF width field ends 18 bytes before the end (2 more SOF bytes, 16 trailing).
      const end = sizeFieldEnd || full.length - 18;
      for (let n = 0; n < end; n++) {
        expect(displayedPixelSize(full.subarray(0, n))).toBeUndefined();
      }
      expect(displayedPixelSize(full)).toBeDefined();
    }
  });

  it("ignores an EXIF block whose offsets point outside it", () => {
    const app1 = exifApp1(6);
    app1.writeUInt32BE(0xfffffff0, 4 + 6 + 4); // IFD0 offset far beyond the payload
    expect(displayedPixelSize(jpeg(1200, 896, app1))).toEqual({ width: 1200, height: 896 });
    const manyEntries = exifApp1(6);
    manyEntries.writeUInt16BE(0x0100, 4 + 6 + 8); // 256 entries declared, 1 present
    manyEntries.writeUInt16BE(0x0100, 4 + 6 + 10); // and the one present is not the orientation
    expect(displayedPixelSize(jpeg(1200, 896, manyEntries))).toEqual({ width: 1200, height: 896 });
  });
});
