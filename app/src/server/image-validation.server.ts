import sharp from "sharp";

export const MAX_IMAGE_PIXELS = 40_000_000;

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
