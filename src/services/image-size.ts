/**
 * Pixel sizes read from image headers, without decoding: no `sharp`, no pixel
 * data. Every reader bounds-checks against the buffer it is given and returns
 * undefined for anything it cannot follow (truncated, hostile, or another
 * format); none of them throws.
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** Both edges positive, or nothing: a zero edge means the header was misread. */
function size(width: number, height: number): PixelSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Walk a JPEG's marker segments to its SOF header, noting the EXIF orientation
 * on the way (APP1 precedes the frame header in every file the spec allows).
 */
function walkJpeg(buf: Buffer): (PixelSize & { orientation?: number }) | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let orientation: number | undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined; // lost marker sync
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI or scan data before any SOF
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const found = size(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      return found && { ...found, orientation };
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return undefined; // a length counts its own two bytes
    if (marker === 0xe1 && orientation === undefined) {
      orientation = exifOrientation(buf.subarray(i + 4, Math.min(buf.length, i + 2 + length)));
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * The orientation tag (0x0112) of IFD0 in an APP1 payload, or undefined. The
 * payload is "Exif\0\0" and a TIFF structure whose offsets are relative to it,
 * so every offset is checked against the payload's own length.
 */
function exifOrientation(app1: Buffer): number | undefined {
  if (app1.length < 14 || app1.toString("latin1", 0, 6) !== "Exif\0\0") return undefined;
  const tiff = app1.subarray(6);
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const le = order === "II";
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const entries = u16(ifd);
  for (let n = 0; n < entries; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > tiff.length) return undefined;
    // Tag 0x0112, type SHORT (3): the value sits in the first two bytes of the value field.
    if (u16(entry) === 0x0112) return u16(entry + 2) === 3 ? u16(entry + 8) : undefined;
  }
  return undefined;
}

/**
 * A JPEG's stored pixel size from its SOF segment, ignoring EXIF orientation.
 * Gemini reports no output dimensions and returns JPEG only, so this is how its
 * delivered size is measured.
 */
export function jpegPixelSize(buf: Buffer): PixelSize | undefined {
  const found = walkJpeg(buf);
  return found && { width: found.width, height: found.height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: the IHDR chunk, which must come first. */
function pngPixelSize(buf: Buffer): PixelSize | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return size(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

/** GIF: the logical screen descriptor. */
function gifPixelSize(buf: Buffer): PixelSize | undefined {
  if (buf.length < 10) return undefined;
  const signature = buf.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return size(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

/** WebP: the canvas of VP8X, or the frame header of a simple VP8 / VP8L file. */
function webpPixelSize(buf: Buffer): PixelSize | undefined {
  if (buf.length < 30) return undefined; // every chunk kind below reads within 30 bytes
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return undefined;
  switch (buf.toString("latin1", 12, 16)) {
    case "VP8X":
      // 24-bit little-endian canvas width-1 and height-1.
      return size(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
    case "VP8L":
      if (buf[20] !== 0x2f) return undefined;
      // 14 bits width-1, then 14 bits height-1, little-endian bit order.
      return size(
        1 + (buf[21] | ((buf[22] & 0x3f) << 8)),
        1 + ((buf[22] >> 6) | (buf[23] << 2) | ((buf[24] & 0x0f) << 10))
      );
    case "VP8 ":
      // A key frame's start code, then 14-bit width and height (top 2 bits are scale).
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
      return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    default:
      return undefined;
  }
}

/**
 * The size an image is displayed at, from its header bytes: JPEG (with EXIF
 * orientation 5-8, which rotate by 90 degrees, swapping the edges), PNG, WebP
 * or GIF, recognised by signature rather than by the declared MIME type.
 * Undefined for anything else, HEIC/HEIF included: it has no cheap header.
 */
export function displayedPixelSize(buf: Buffer): PixelSize | undefined {
  const jpeg = walkJpeg(buf);
  if (jpeg) {
    const rotated = jpeg.orientation !== undefined && jpeg.orientation >= 5 && jpeg.orientation <= 8;
    return rotated ? { width: jpeg.height, height: jpeg.width } : { width: jpeg.width, height: jpeg.height };
  }
  return pngPixelSize(buf) ?? webpPixelSize(buf) ?? gifPixelSize(buf);
}
