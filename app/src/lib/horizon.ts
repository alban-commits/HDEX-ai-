import type { Generation } from "@higgsfield/fnf/client";
import { selectGenerationMedia } from "./higgsfield-generation-results";

export const HORIZON_MAX_IMAGES = 14;
export const HORIZON_MAX_FOLDER_FILES = 5_000;
export const HORIZON_MAX_FOLDER_DEPTH = 20;
export const HORIZON_RATIOS = ["2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "1:1"] as const;
export const HORIZON_VIEWS = ["auto", "front", "side", "back"] as const;

export type HorizonView = (typeof HORIZON_VIEWS)[number];
export type HorizonRole = "model" | "wardrobe" | "accessory";
export type HorizonEngine = "gpt-2k" | "nano-2k" | "nano-4k";
export type HorizonBatchDownload = { url: string; filename: string };
export type HorizonBatchStatus = "queued" | "prompting" | "generating" | "saving" | "completed" | "failed";
export type HorizonBatchFailureStage = "uploading" | "prompting" | "generating" | "saving";

export class HorizonBatchStepError extends Error {
  constructor(
    public readonly stage: HorizonBatchFailureStage,
    message: string,
  ) {
    super(message);
    this.name = "HorizonBatchStepError";
  }
}

export function horizonBatchFailureMessage(error: unknown): string {
  if (error instanceof HorizonBatchStepError) return error.message;
  return "작업을 완료하지 못했습니다.";
}

export function horizonBatchStageFailureMessage(stage: HorizonBatchFailureStage): string {
  if (stage === "uploading") return "참조 이미지 업로드에 실패했습니다.";
  if (stage === "prompting") return "GPT 명령어 작성에 실패했습니다.";
  if (stage === "generating") return "이미지 생성 요청 또는 결과 처리에 실패했습니다.";
  return "완성 이미지 저장에 실패했습니다.";
}

export function settleHorizonBatchStatus(status: HorizonBatchStatus, ready: boolean): HorizonBatchStatus {
  return ready && status !== "completed" && status !== "failed" ? "failed" : status;
}

export async function runHorizonBatchSequence<T extends { ready: boolean }>(
  items: readonly T[],
  process: (item: T) => Promise<void>,
  onFailure: (item: T, error: unknown) => void,
): Promise<void> {
  for (const item of items) {
    if (!item.ready) continue;
    try {
      await process(item);
    } catch (error) {
      onFailure(item, error);
    }
  }
}

type HorizonGenerationIdentity = {
  input: {
    model: string;
    settings: unknown;
  };
};

export function horizonGenerationMatchesEngine(
  generation: HorizonGenerationIdentity,
  engine: HorizonEngine,
): boolean {
  const target = engine === "gpt-2k"
    ? { model: "gpt_image_2", resolution: "2k" }
    : { model: "nano_banana_2", resolution: engine === "nano-4k" ? "4k" : "2k" };
  const settings = generation.input.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const resolution = (settings as Record<string, unknown>).resolution;
  return generation.input.model === target.model
    && typeof resolution === "string"
    && resolution.toLowerCase() === target.resolution;
}

function safeFolderName(value: string): string {
  const printable = [...value].map((character) => character.charCodeAt(0) < 32 ? "-" : character).join("");
  return printable.replace(/[<>:"/\\|?*]/g, "-").trim().slice(0, 80) || "result";
}

function safeResultExtension(url: string): string {
  try {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (extension && ["jpg", "jpeg", "png", "webp"].includes(extension)) return extension;
  } catch {}
  return "png";
}

export function horizonBatchDownloadFilename(
  folderName: string,
  index: number,
  quantity: number,
  url: string,
): string {
  const suffix = quantity > 1 ? `_${String(index).padStart(2, "0")}` : "";
  return `${safeFolderName(folderName)}${suffix}.${safeResultExtension(url)}`;
}

export function resolveHorizonBatchOutcome(
  generations: readonly Generation[],
  engine: HorizonEngine,
  folderName: string,
  expectedCount: number,
): { results: HorizonBatchDownload[]; successCount: number; failureCount: number } {
  const urls = generations.flatMap((generation) => {
    if (!horizonGenerationMatchesEngine(generation, engine)) return [];
    const media = selectGenerationMedia(generation);
    return media.kind === "empty" ? [] : [media.rawUrl];
  });
  return {
    results: urls.map((url, index) => ({
      url,
      filename: horizonBatchDownloadFilename(folderName, index + 1, expectedCount, url),
    })),
    successCount: urls.length,
    failureCount: Math.max(expectedCount - urls.length, generations.length - urls.length, 0),
  };
}

export function claimHorizonImageReservation(
  currentCount: number,
  reservedCount: number,
  incomingCount: number,
): number | null {
  if (
    !Number.isSafeInteger(currentCount) || currentCount < 0 ||
    !Number.isSafeInteger(reservedCount) || reservedCount < 0 ||
    !Number.isSafeInteger(incomingCount) || incomingCount < 1 ||
    currentCount + reservedCount + incomingCount > HORIZON_MAX_IMAGES
  ) return null;
  return reservedCount + incomingCount;
}

export function horizonBatchProgress(
  jobs: readonly { ready: boolean; status: string }[],
): { processed: number; total: number; percent: number } {
  const runnable = jobs.filter((job) => job.ready);
  const processed = runnable.filter((job) => job.status === "completed" || job.status === "failed").length;
  return {
    processed,
    total: runnable.length,
    percent: runnable.length === 0 ? 0 : Math.round((processed / runnable.length) * 100),
  };
}

export function horizonConnectionState(scopeKey: string | undefined, guestScopeKey = "guest") {
  return scopeKey === undefined
    ? { status: "loading" as const, label: "Higgsfield 연결 확인 중" }
    : scopeKey === guestScopeKey
      ? { status: "disconnected" as const, label: "Higgsfield 로그인 필요" }
      : { status: "connected" as const, label: "Higgsfield OAuth 연결됨" };
}

export type HorizonSlot = {
  id: string;
  group: HorizonRole;
  label: string;
  hint: string;
  view?: Exclude<HorizonView, "auto">;
};

export const HORIZON_SLOTS: readonly HorizonSlot[] = [
  { id: "model-front", group: "model", label: "모델 정면", hint: "FRONT", view: "front" },
  { id: "model-side", group: "model", label: "모델 측면/45도", hint: "SIDE / 3/4", view: "side" },
  { id: "model-back", group: "model", label: "모델 후면", hint: "BACK", view: "back" },
  { id: "full-look", group: "wardrobe", label: "전신 착장", hint: "FULL LOOK" },
  { id: "top", group: "wardrobe", label: "상의 디테일", hint: "TOP" },
  { id: "bottom", group: "wardrobe", label: "하의 디테일", hint: "BOTTOM" },
  { id: "accessory", group: "accessory", label: "액세서리/착용법", hint: "ACCESSORY" },
  { id: "shoes", group: "accessory", label: "신발", hint: "SHOES" },
  { id: "socks", group: "accessory", label: "양말", hint: "SOCKS" },
] as const;

export type HorizonImage = {
  id: string;
  slotId: string;
  code: string;
  category: string;
  selected: boolean;
  name: string;
};

function groupPrefix(group: HorizonRole): "M" | "W" | "A" {
  return group === "model" ? "M" : group === "wardrobe" ? "W" : "A";
}

export function renumberHorizonImages(images: readonly Omit<HorizonImage, "code">[]): HorizonImage[] {
  const counts: Record<HorizonRole, number> = { model: 0, wardrobe: 0, accessory: 0 };
  return images.map((image) => {
    const slot = HORIZON_SLOTS.find((candidate) => candidate.id === image.slotId);
    if (!slot) throw new Error("invalid_horizon_slot");
    counts[slot.group] += 1;
    return { ...image, code: `${groupPrefix(slot.group)}${counts[slot.group]}` };
  });
}

export function selectHorizonImages(
  images: readonly HorizonImage[],
  brief: string,
  view: HorizonView,
): HorizonImage[] {
  const requested = new Set(
    [...brief.toUpperCase().matchAll(/\b[MWA]\d+\b/g)].map((match) => match[0]),
  );
  const hasExplicitCodes = requested.size > 0;
  return images.filter((image) => {
    if (!image.selected) return false;
    const slot = HORIZON_SLOTS.find((candidate) => candidate.id === image.slotId);
    if (!slot) return false;
    if (slot.group === "model" && view !== "auto" && slot.view !== view) return false;
    if (!hasExplicitCodes) return true;
    if (requested.has(image.code)) return true;
    return slot.group === "model" && ![...requested].some((code) => code.startsWith("M"));
  });
}

const BATCH_ROLE: Record<number, { slotId: string; category: string }> = {
  1: { slotId: "model-front", category: "M1 · 모델 기준" },
  2: { slotId: "full-look", category: "W1 · 전신 착장" },
  3: { slotId: "top", category: "W2 · 상의 디테일" },
  4: { slotId: "bottom", category: "W3 · 하의 디테일" },
  5: { slotId: "shoes", category: "A1 · 신발" },
  6: { slotId: "socks", category: "A2 · 양말" },
  7: { slotId: "accessory", category: "A3 · 액세서리/착용법" },
  8: { slotId: "accessory", category: "A4 · 액세서리/착용법" },
};

export type HorizonBatchFile = {
  file: File;
  relativePath: string;
  number: number;
  slotId: string;
  category: string;
};

export type HorizonBatchJob = {
  key: string;
  name: string;
  ready: boolean;
  error?: "model_reference_missing" | "no_recognized_images" | "too_many_images" | "unsupported_format";
  files: HorizonBatchFile[];
};

function relativeFilePath(file: File): string {
  const candidate = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return candidate && !candidate.includes("\\") ? candidate : file.name;
}

export function scanHorizonFolder(files: readonly File[]): HorizonBatchJob[] {
  const groups = new Map<string, { files: HorizonBatchFile[]; supportedImage: boolean; unsupportedNumberedImage: boolean }>();
  for (const file of files.slice(0, HORIZON_MAX_FOLDER_FILES)) {
    const relativePath = relativeFilePath(file);
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length - 1 > HORIZON_MAX_FOLDER_DEPTH) continue;
    const directories = segments.slice(0, -1);
    if (directories.some((segment) => segment.startsWith(".") || segment === "완성본")) continue;
    const name = segments.at(-1) ?? file.name;
    const stem = name.replace(/\.[^.]+$/, "");
    const match = stem.match(/^([1-8])(?:$|[-_. ].*)/);
    const folder = segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
    const supportedImage = /\.(?:jpe?g|png|webp)$/i.test(name) || /^image\/(?:jpeg|png|webp)$/i.test(file.type);
    const unsupportedImage = /\.(?:gif|bmp|tiff?|avif|heic|heif)$/i.test(name) || (/^image\//i.test(file.type) && !supportedImage);
    if (!supportedImage && !(match && unsupportedImage)) continue;
    const group = groups.get(folder) ?? { files: [], supportedImage: false, unsupportedNumberedImage: false };
    group.supportedImage ||= supportedImage;
    group.unsupportedNumberedImage ||= Boolean(match && unsupportedImage);
    if (match && supportedImage) {
      const number = Number(match[1]);
      const role = BATCH_ROLE[number];
      if (role) group.files.push({ file, relativePath, number, ...role });
    }
    groups.set(folder, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "ko", { numeric: true }))
    .map(([key, group]) => {
      const entries = group.files;
      entries.sort((left, right) => left.number - right.number || left.relativePath.localeCompare(right.relativePath, "ko", { numeric: true }));
      const roleTotals = new Map<number, number>();
      for (const entry of entries) {
        roleTotals.set(entry.number, (roleTotals.get(entry.number) ?? 0) + 1);
      }
      const roleCounts = new Map<number, number>();
      const uniqueEntries = entries.map((entry) => {
        const count = (roleCounts.get(entry.number) ?? 0) + 1;
        roleCounts.set(entry.number, count);
        const [code, label] = entry.category.split(" · ");
        const groupedCode = (roleTotals.get(entry.number) ?? 0) > 1 ? `${code}-${count}` : code;
        return { ...entry, category: `${groupedCode} · ${label}` };
      });
      const hasModelReference = entries.some((entry) => entry.number === 1);
      const tooManyImages = entries.length > HORIZON_MAX_IMAGES;
      const ready = hasModelReference && !tooManyImages;
      const error = tooManyImages
        ? ("too_many_images" as const)
        : entries.length === 0 && group.unsupportedNumberedImage
          ? ("unsupported_format" as const)
          : entries.length === 0
            ? ("no_recognized_images" as const)
            : ("model_reference_missing" as const);
      return {
        key,
        name: key === "." ? "선택한 폴더" : key,
        ready,
        ...(ready ? {} : { error }),
        files: uniqueEntries,
      };
    });
}

export function boundedHorizonFolderFiles(files: ArrayLike<File>): File[] {
  const bounded: File[] = [];
  const count = Math.min(files.length, HORIZON_MAX_FOLDER_FILES);
  for (let index = 0; index < count; index += 1) {
    const file = files[index];
    if (file) bounded.push(file);
  }
  return bounded;
}
