/** Bounded, disposable previews. Never writes or replaces provider image bytes. */
import type { ImageToolOutput } from "../schemas/output.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 25_000_000;
const MAX_INPUT_EDGE = 16_384;
const MAX_OUTPUT_BYTES = 200 * 1024;
const PANEL_EDGE = 512;

type PreviewMetadata = NonNullable<ImageToolOutput["images"][number]["preview"]>;
export type ImagePreview = Omit<PreviewMetadata, "content_index"> & { data: string };

/** Only these controlled reasons reach callers; native error text stays private. */
export class PreviewUnavailable extends Error {}

export async function createImagePreview(data: string, mimeType: string): Promise<ImagePreview> {
  if (data.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3)) {
    throw new PreviewUnavailable("input exceeds the 32 MiB preview limit");
  }
  const input = Buffer.from(data, "base64");
  if (input.length > MAX_INPUT_BYTES) {
    throw new PreviewUnavailable("input exceeds the 32 MiB preview limit");
  }
  // Reject other decoders before sharp sees the input (in particular SVG).
  const format = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "jpeg"
    : input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP" ? "webp"
    : undefined;
  if (!format || mimeType !== `image/${format}`) {
    throw new PreviewUnavailable("unsupported image signature or MIME type");
  }

  // libvips can expose only APNG's first frame without reporting metadata.pages.
  // Walk actual PNG chunks; a text payload containing "acTL" is not animation.
  if (format === "png") {
    for (let offset = 8; offset < input.length;) {
      if (input.length - offset < 12) throw new PreviewUnavailable("invalid PNG chunk layout");
      const length = input.readUInt32BE(offset);
      if (length > input.length - offset - 12) throw new PreviewUnavailable("invalid PNG chunk layout");
      const type = input.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") throw new PreviewUnavailable("preview supports single-frame 8-bit JPEG, PNG and WebP only");
      if (type === "IEND") break;
      offset += length + 12;
    }
  }

  const sharp = await import("sharp").then((module) => module.default).catch(() => {
    throw new PreviewUnavailable("optional image decoder unavailable");
  });
  const source = () => sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    limitInputChannels: 4,
    failOn: "warning",
    pages: 1,
  }).timeout({ seconds: 3 });
  const metadata = await source().metadata();
  if (metadata.format !== format || metadata.depth !== "uchar" || (metadata.pages ?? 1) !== 1) {
    throw new PreviewUnavailable("preview supports single-frame 8-bit JPEG, PNG and WebP only");
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS ||
      metadata.width > MAX_INPUT_EDGE || metadata.height > MAX_INPUT_EDGE) {
    throw new PreviewUnavailable("input exceeds the preview pixel or edge limit");
  }

  // stats reads original pixels, regardless of later resize/composite operations.
  // The final channel is alpha for both gray+alpha and RGB+alpha input.
  const alphaStats = metadata.hasAlpha ? (await source().stats()).channels.at(-1) : undefined;
  if (metadata.hasAlpha && !alphaStats) throw new PreviewUnavailable("alpha inspection unavailable");
  const alpha = {
    has_channel: metadata.hasAlpha,
    min: alphaStats?.min ?? 255,
    max: alphaStats?.max ?? 255,
  };
  const transparent = alpha.min < 255;
  const thumb = await source().rotate().resize({
    width: PANEL_EDGE, height: PANEL_EDGE, fit: "inside", withoutEnlargement: true,
  }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { width: thumb.info.width, height: thumb.info.height, channels: 4 as const };
  const panel = (background: string) => sharp(thumb.data, { raw })
    .flatten({ background }).timeout({ seconds: 3 });
  let encoded;
  if (transparent) {
    const white = await panel("#ffffff").raw().toBuffer();
    const navy = await panel("#14283c").raw().toBuffer();
    const panelRaw = { ...raw, channels: 3 as const };
    encoded = await sharp({ create: {
      width: raw.width * 2, height: raw.height, channels: 3, background: "#ffffff",
    } }).composite([
      { input: white, raw: panelRaw, left: 0, top: 0 },
      { input: navy, raw: panelRaw, left: raw.width, top: 0 },
    ]).jpeg({ quality: 75 }).timeout({ seconds: 3 }).toBuffer({ resolveWithObject: true });
  } else {
    encoded = await panel("#ffffff").jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
  }
  if (encoded.data.length > MAX_OUTPUT_BYTES) {
    throw new PreviewUnavailable("derived JPEG exceeds the 200 KiB preview limit");
  }
  return {
    data: encoded.data.toString("base64"),
    width: encoded.info.width,
    height: encoded.info.height,
    background: transparent ? "white_and_navy" : "original",
    alpha,
  };
}
