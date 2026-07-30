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
};

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
  const assets: AssetSelection[] = [];
  try {
    for (const file of files) assets.push(await upload(file));
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
