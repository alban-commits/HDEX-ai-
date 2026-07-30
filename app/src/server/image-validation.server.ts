import sharp from "sharp";

export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_NORMALIZED_PNG_BYTES = 40 * 1024 * 1024;

const formatsByContentType = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export async function validateImageBytes(input: {
  bytes: Uint8Array;
  contentType: keyof typeof formatsByContentType;
  maxBytes: number;
  maxPixels?: number;
}): Promise<{ width: number; height: number; format: string }> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.maxBytes) {
    throw new Error("image_size_invalid");
  }
  const maxPixels = input.maxPixels ?? MAX_IMAGE_PIXELS;
  const image = sharp(input.bytes, {
    failOn: "error",
    limitInputPixels: maxPixels,
    pages: 1,
  });
  const metadata = await image.metadata();
  const expectedFormat = formatsByContentType[input.contentType];
  if (
    metadata.format !== expectedFormat ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > maxPixels ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error("image_decode_invalid");
  }
  // Force a full pixel decode; metadata alone does not reject every truncated image.
  await image.clone().resize(1, 1, { fit: "fill" }).raw().toBuffer();
  return { width: metadata.width, height: metadata.height, format: metadata.format };
}

export async function normalizeHiggsfieldUploadImage(input: {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  maxOriginalBytes: number;
}): Promise<{ bytes: Uint8Array; contentType: "image/jpeg" | "image/png"; extension: "jpg" | "png"; normalized: boolean }> {
  await validateImageBytes({
    bytes: input.bytes,
    contentType: input.contentType,
    maxBytes: input.maxOriginalBytes,
  });
  if (input.contentType !== "image/webp") {
    return {
      bytes: input.bytes,
      contentType: input.contentType,
      extension: input.contentType === "image/png" ? "png" : "jpg",
      normalized: false,
    };
  }
  const normalized = new Uint8Array(await sharp(input.bytes, {
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
    pages: 1,
  }).png({ compressionLevel: 9 }).toBuffer());
  if (normalized.byteLength === 0 || normalized.byteLength > MAX_NORMALIZED_PNG_BYTES) {
    throw new Error("normalized_image_size_invalid");
  }
  await validateImageBytes({
    bytes: normalized,
    contentType: "image/png",
    maxBytes: MAX_NORMALIZED_PNG_BYTES,
  });
  return { bytes: normalized, contentType: "image/png", extension: "png", normalized: true };
}
