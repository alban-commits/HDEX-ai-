import { HORIZON_MAX_FOLDER_DEPTH, HORIZON_MAX_FOLDER_FILES, scanHorizonFolder, type HorizonBatchDownload, type HorizonBatchJob } from "./horizon";
import { createHorizonPngPsdArtifacts, type HorizonPngPsdArtifacts } from "./horizon-restore.browser";

export type HorizonDirectoryPermission = "granted" | "denied" | "prompt";

export type HorizonFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
};

export type HorizonDirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<HorizonDirectoryHandle | HorizonFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<HorizonDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<HorizonFileHandle>;
  removeEntry?(name: string): Promise<void>;
  queryPermission(options: { mode: "readwrite" }): Promise<HorizonDirectoryPermission>;
  requestPermission(options: { mode: "readwrite" }): Promise<HorizonDirectoryPermission>;
};

export type HorizonDirectoryHandleStore = {
  load(): Promise<HorizonDirectoryHandle | null>;
  save(handle: HorizonDirectoryHandle): Promise<void>;
};

export class HorizonDirectoryScanError extends Error {
  readonly code = "folder_file_limit_exceeded";

  constructor() {
    super("folder_file_limit_exceeded");
  }
}

export type HorizonDirectoryPickerWindow = {
  showDirectoryPicker?: (options: {
    id: string;
    mode: "readwrite";
    startIn: "desktop";
  }) => Promise<HorizonDirectoryHandle>;
};

const DATABASE_NAME = "hdex-horizon-browser";
const STORE_NAME = "directory-handles";
const BATCH_ROOT_KEY = "batch-root";

function openDirectoryDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("directory_store_unavailable"));
  });
}

export function createHorizonDirectoryHandleStore(
  factory: IDBFactory = indexedDB,
): HorizonDirectoryHandleStore {
  return {
    async load() {
      const database = await openDirectoryDatabase(factory);
      try {
        return await new Promise<HorizonDirectoryHandle | null>((resolve, reject) => {
          const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(BATCH_ROOT_KEY);
          request.onsuccess = () => resolve((request.result as HorizonDirectoryHandle | undefined) ?? null);
          request.onerror = () => reject(new Error("directory_store_unavailable"));
        });
      } finally {
        database.close();
      }
    },
    async save(handle) {
      const database = await openDirectoryDatabase(factory);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(handle, BATCH_ROOT_KEY);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error("directory_store_unavailable"));
          transaction.onabort = () => reject(new Error("directory_store_unavailable"));
        });
      } finally {
        database.close();
      }
    },
  };
}

export function horizonDirectoryPickerFor(
  browserWindow: HorizonDirectoryPickerWindow,
): HorizonDirectoryPickerWindow["showDirectoryPicker"] {
  return browserWindow.showDirectoryPicker?.bind(browserWindow);
}

function browserPicker(): HorizonDirectoryPickerWindow["showDirectoryPicker"] {
  if (typeof window === "undefined") return undefined;
  return horizonDirectoryPickerFor(window as HorizonDirectoryPickerWindow);
}

export function supportsHorizonDirectoryPicker(): boolean {
  return typeof browserPicker() === "function" && typeof indexedDB !== "undefined";
}

export async function pickHorizonBatchDirectory(input: {
  picker?: NonNullable<HorizonDirectoryPickerWindow["showDirectoryPicker"]>;
  store?: HorizonDirectoryHandleStore;
} = {}): Promise<{ handle: HorizonDirectoryHandle; remembered: boolean }> {
  const picker = input.picker ?? browserPicker();
  if (!picker) throw new Error("directory_picker_unsupported");
  const handle = await picker({ id: "hdex-horizon-batch", mode: "readwrite", startIn: "desktop" });
  try {
    await (input.store ?? createHorizonDirectoryHandleStore()).save(handle);
    return { handle, remembered: true };
  } catch {
    return { handle, remembered: false };
  }
}

export async function restoreHorizonBatchDirectory(
  store: HorizonDirectoryHandleStore = createHorizonDirectoryHandleStore(),
): Promise<{ handle: HorizonDirectoryHandle; permission: HorizonDirectoryPermission } | null> {
  const handle = await store.load();
  if (!handle) return null;
  return { handle, permission: await handle.queryPermission({ mode: "readwrite" }) };
}

export async function requestHorizonBatchDirectoryPermission(
  handle: HorizonDirectoryHandle,
): Promise<HorizonDirectoryPermission> {
  return handle.requestPermission({ mode: "readwrite" });
}

function withRelativePath(file: File, relativePath: string): File {
  try {
    Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: relativePath });
    return file;
  } catch {
    const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
    Object.defineProperty(copy, "webkitRelativePath", { value: relativePath });
    return copy;
  }
}

export async function scanHorizonDirectory(handle: HorizonDirectoryHandle): Promise<HorizonBatchJob[]> {
  const files: File[] = [];
  let limitReached = false;
  const visit = async (directory: HorizonDirectoryHandle, segments: string[], depth: number): Promise<void> => {
    if (depth > HORIZON_MAX_FOLDER_DEPTH || limitReached) return;
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") {
        if (entry.name.startsWith(".") || entry.name === "완성본") continue;
        await visit(entry, [...segments, entry.name], depth + 1);
      } else {
        if (files.length >= HORIZON_MAX_FOLDER_FILES) { limitReached = true; break; }
        files.push(withRelativePath(await entry.getFile(), [...segments, entry.name].join("/")));
      }
    }
  };
  await visit(handle, [], 0);
  if (limitReached) throw new HorizonDirectoryScanError();
  return scanHorizonFolder(files).map((job) => job.key === "." ? { ...job, name: "루트 폴더" } : job);
}

function splitFilename(filename: string): { base: string; extension: string } {
  const printable = [...filename.normalize("NFKC")].map((character) => character.charCodeAt(0) < 32 ? "-" : character).join("");
  const safe = printable.replace(/[<>:"/\\|?*]+/g, "-").slice(0, 120) || "horizon-result.png";
  const at = safe.lastIndexOf(".");
  return at > 0 ? { base: safe.slice(0, at), extension: safe.slice(at) } : { base: safe, extension: ".png" };
}

function filenameForImageType(filename: string, contentType: string): string {
  const { base } = splitFilename(filename);
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const extension = normalized === "image/jpeg" || normalized === "image/jpg"
    ? ".jpg"
    : normalized === "image/webp"
      ? ".webp"
      : ".png";
  return `${base}${extension}`;
}

async function uniqueOutputFile(directory: HorizonDirectoryHandle, preferredName: string): Promise<{ handle: HorizonFileHandle; name: string }> {
  const { base, extension } = splitFilename(preferredName);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = suffix === 1 ? `${base}${extension}` : `${base}_${suffix}${extension}`;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (!error || typeof error !== "object" || !("name" in error) || error.name !== "NotFoundError") throw error;
      const handle = await directory.getFileHandle(name, { create: true });
      return { handle, name };
    }
  }
  throw new Error("output_name_unavailable");
}

async function fetchResultBlob(input: {
  result: HorizonBatchDownload;
  fetchResult: typeof fetch;
  publicOrigin: string;
}): Promise<Blob> {
  const resultUrl = new URL(input.result.url, input.publicOrigin);
  if (resultUrl.origin !== input.publicOrigin || !resultUrl.pathname.startsWith("/api/higgsfield/result/") || resultUrl.search || resultUrl.hash) {
    throw new Error("result_url_invalid");
  }
  const response = await input.fetchResult(`${resultUrl.pathname}`, { credentials: "include" });
  if (!response.ok) throw new Error("result_download_failed");
  const blob = await response.blob();
  if (!blob.type.toLowerCase().startsWith("image/")) throw new Error("result_type_invalid");
  return blob;
}

async function writeBlobFile(directory: HorizonDirectoryHandle, filename: string, blob: Blob): Promise<string> {
  const output = await uniqueOutputFile(directory, filename);
  if (!output.handle.createWritable) throw new Error("directory_write_unsupported");
  const writable = await output.handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
    return output.name;
  } catch {
    await writable.abort?.().catch(() => undefined);
    await directory.removeEntry?.(output.name).catch(() => undefined);
    throw new Error("result_write_failed");
  }
}

async function writeResultFile(input: {
  directory: HorizonDirectoryHandle;
  result: HorizonBatchDownload;
  fetchResult: typeof fetch;
  publicOrigin: string;
}): Promise<string> {
  const blob = await fetchResultBlob(input);
  return writeBlobFile(input.directory, filenameForImageType(input.result.filename, blob.type), blob);
}

export async function saveHorizonBatchResults(input: {
  root: HorizonDirectoryHandle;
  results: readonly HorizonBatchDownload[];
  fetchResult?: typeof fetch;
  publicOrigin?: string;
}): Promise<{ savedFiles: string[]; failureCount: number }> {
  let output: HorizonDirectoryHandle;
  try {
    output = await input.root.getDirectoryHandle("완성본", { create: true });
  } catch {
    return { savedFiles: [], failureCount: input.results.length };
  }
  const publicOrigin = input.publicOrigin ?? (typeof window === "undefined" ? "https://hdex.invalid" : window.location.origin);
  const savedFiles: string[] = [];
  let failureCount = 0;
  for (const result of input.results) {
    try {
      savedFiles.push(await writeResultFile({ directory: output, result, fetchResult: input.fetchResult ?? fetch, publicOrigin }));
    } catch {
      failureCount += 1;
    }
  }
  return { savedFiles, failureCount };
}

export async function saveHorizonBatchPngPsd(input: {
  root: HorizonDirectoryHandle;
  original: Blob;
  results: readonly HorizonBatchDownload[];
  fetchResult?: typeof fetch;
  publicOrigin?: string;
  createArtifacts?: (input: { original: Blob; generated: Blob; filename: string }) => Promise<HorizonPngPsdArtifacts>;
}): Promise<{ savedFiles: string[]; savedResultCount: number; failureCount: number; failedResults: HorizonBatchDownload[] }> {
  let output: HorizonDirectoryHandle;
  try {
    output = await input.root.getDirectoryHandle("완성본", { create: true });
  } catch {
    return { savedFiles: [], savedResultCount: 0, failureCount: input.results.length, failedResults: [...input.results] };
  }
  const publicOrigin = input.publicOrigin ?? (typeof window === "undefined" ? "https://hdex.invalid" : window.location.origin);
  const createArtifacts = input.createArtifacts ?? createHorizonPngPsdArtifacts;
  const fetchResult = input.fetchResult ?? fetch;
  const savedFiles: string[] = [];
  const failedResults: HorizonBatchDownload[] = [];
  let savedResultCount = 0;
  for (const result of input.results) {
    const writtenForResult: string[] = [];
    try {
      const generated = await fetchResultBlob({ result, fetchResult, publicOrigin });
      const artifacts = await createArtifacts({ original: input.original, generated, filename: result.filename });
      writtenForResult.push(await writeBlobFile(output, artifacts.pngFilename, artifacts.png));
      writtenForResult.push(await writeBlobFile(output, artifacts.psdFilename, artifacts.psd));
      savedFiles.push(...writtenForResult);
      savedResultCount += 1;
    } catch {
      for (const filename of writtenForResult) await output.removeEntry?.(filename).catch(() => undefined);
      failedResults.push(result);
    }
  }
  return {
    savedFiles,
    savedResultCount,
    failureCount: failedResults.length,
    failedResults,
  };
}
