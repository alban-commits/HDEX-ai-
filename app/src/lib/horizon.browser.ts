import { fetchAppJson } from "./app-api-response.browser";
import type { AssetSelection } from "@/components/asset-library";
import {
  getLocalUploadFile,
  notifyHiggsfieldReconnectRequired,
  releaseLocalUpload,
  uploadAsset,
} from "./fnf.browser";

type HorizonPromptResponse =
  | { ok: true; prompt: string; spec: Record<string, unknown>; model: string; promptVersion: string }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown, status: number): value is HorizonPromptResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return status >= 200 && status < 300 && typeof value.prompt === "string" && isRecord(value.spec) && typeof value.promptVersion === "string";
  return typeof value.code === "string" && typeof value.message === "string";
}

type HorizonUploadOperations = {
  upload?: (file: File) => Promise<AssetSelection>;
  release?: (mediaId: string) => void;
  optimize?: (file: File) => Promise<File>;
};

export const HORIZON_UPLOAD_TARGET_BYTES = 18 * 1024 * 1024;
export const HORIZON_UPLOAD_TARGET_PIXELS = 30_000_000;
export const HORIZON_UPLOAD_MAX_EDGE = 6_000;

type HorizonDecodedImage = {
  width: number;
  height: number;
  close: () => void;
};

type HorizonImageOptimizationOperations = {
  decode?: (file: File) => Promise<HorizonDecodedImage>;
  encodeJpeg?: (
    image: HorizonDecodedImage,
    width: number,
    height: number,
    quality: number,
  ) => Promise<Blob>;
};

export function horizonOptimizedDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const pixelScale = Math.sqrt(HORIZON_UPLOAD_TARGET_PIXELS / (width * height));
  const scale = Math.min(
    1,
    HORIZON_UPLOAD_MAX_EDGE / width,
    HORIZON_UPLOAD_MAX_EDGE / height,
    pixelScale,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

async function decodeBrowserImage(file: File): Promise<HorizonDecodedImage> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

async function encodeBrowserJpeg(
  image: HorizonDecodedImage,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("horizon_image_canvas_unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("horizon_image_encode_failed")),
      "image/jpeg",
      quality,
    );
  });
}

export async function optimizeHorizonUploadFile(
  file: File,
  operations: HorizonImageOptimizationOperations = {},
): Promise<File> {
  const decode = operations.decode
    ?? (typeof createImageBitmap === "function" ? decodeBrowserImage : null);
  if (!decode) return file;
  const image = await decode(file);
  try {
    const target = horizonOptimizedDimensions(image.width, image.height);
    const requiresOptimization = file.size > HORIZON_UPLOAD_TARGET_BYTES
      || target.width !== image.width
      || target.height !== image.height;
    if (!requiresOptimization) return file;
    const encodeJpeg = operations.encodeJpeg ?? encodeBrowserJpeg;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = 0.85 ** attempt;
      const width = Math.max(1, Math.floor(target.width * scale));
      const height = Math.max(1, Math.floor(target.height * scale));
      const quality = Math.max(0.65, 0.92 - attempt * 0.06);
      const blob = await encodeJpeg(image, width, height, quality);
      if (blob.size <= HORIZON_UPLOAD_TARGET_BYTES) {
        const name = file.name.replace(/\.[^.]+$/, "") || "reference";
        return new File([blob], `${name}.jpg`, {
          type: "image/jpeg",
          lastModified: file.lastModified,
        });
      }
    }
    throw new Error("horizon_image_optimization_failed");
  } finally {
    image.close();
  }
}

function releaseAssets(
  assets: readonly AssetSelection[],
  release: (mediaId: string) => void,
): void {
  for (const asset of assets) {
    if (asset.ref?.id) release(asset.ref.id);
  }
}

export async function uploadHorizonAssets(
  files: readonly File[],
  operations: HorizonUploadOperations = {},
): Promise<AssetSelection[]> {
  const upload = operations.upload ?? uploadAsset;
  const release = operations.release ?? releaseLocalUpload;
  const optimize = operations.optimize ?? optimizeHorizonUploadFile;
  const assets: AssetSelection[] = [];
  try {
    for (const file of files) assets.push(await upload(await optimize(file)));
    return assets;
  } catch (error) {
    releaseAssets(assets, release);
    throw error;
  }
}

export async function withHorizonUploadedAssets<T>(
  files: readonly File[],
  task: (assets: readonly AssetSelection[]) => Promise<T>,
  operations: HorizonUploadOperations = {},
): Promise<T> {
  const release = operations.release ?? releaseLocalUpload;
  const assets = await uploadHorizonAssets(files, operations);
  try {
    return await task(assets);
  } finally {
    releaseAssets(assets, release);
  }
}

export async function runHorizonGenerationFlow<T>(input: {
  command: string;
  writePrompt: () => Promise<string | null>;
  generate: (command: string) => Promise<T>;
}): Promise<T | null> {
  const command = input.command.trim() || await input.writePrompt();
  return command ? input.generate(command) : null;
}

export async function composeHorizonPrompt(input: { brief: string; ratio: string; targetView: string; images: Array<{ mediaId: string; category: string }> }): Promise<HorizonPromptResponse> {
  const form = new FormData();
  const categories: string[] = [];
  for (const image of input.images) {
    const file = getLocalUploadFile(image.mediaId);
    if (!file) return { ok: false, code: "image_file_unavailable", message: "참조 이미지를 다시 선택해 주세요." };
    form.append("image", file);
    categories.push(image.category);
  }
  form.set("data", JSON.stringify({ brief: input.brief, ratio: input.ratio, targetView: input.targetView, categories }));
  const result = await fetchAppJson<HorizonPromptResponse>({ path: "/api/openai/horizon", init: { method: "POST", credentials: "include", body: form }, isEnvelope: isResponse });
  if (!result.ok && result.code === "oauth_required") notifyHiggsfieldReconnectRequired();
  return result;
}
