import { readFile } from "node:fs/promises";
import { requestPinnedHttps } from "./pinned-https.server";
import { validateImageBytes } from "./image-validation.server";
import { withTemporaryFile } from "./temporary-storage.server";
import type { TemporaryStorageConfig } from "./runtime-config.server";

export const MAX_RESULT_BYTES = 80 * 1024 * 1024;
export const RESULT_DOWNLOAD_TIMEOUT_MS = 120_000;

function trustedResultUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("unsafe_result_url");
  }
  return url;
}

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  throw new Error("unsupported_result_type");
}

async function readFetchBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("result_download_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESULT_BYTES) {
      await reader.cancel();
      throw new Error("result_too_large");
    }
    chunks.push(chunk.value);
  }
  if (total === 0) throw new Error("result_too_large");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadResultThroughTemporaryFile(input: {
  remoteUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
  storageConfig?: TemporaryStorageConfig;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const remoteUrl = trustedResultUrl(input.remoteUrl).toString();
    let contentType: string;
    let declared: string | null;
    let bytes: Uint8Array;
    if (input.fetchImpl) {
      const response = await input.fetchImpl(remoteUrl, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "image/png,image/jpeg,image/webp" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("result_download_failed");
      }
      contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
      declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESULT_BYTES)) {
        await response.body?.cancel();
        throw new Error("result_too_large");
      }
      bytes = await readFetchBytes(response);
    } else {
      const response = await requestPinnedHttps({
        url: remoteUrl,
        method: "GET",
        headers: { Accept: "image/png,image/jpeg,image/webp" },
        maxResponseBytes: MAX_RESULT_BYTES,
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) throw new Error("result_download_failed");
      const rawContentType = response.headers["content-type"];
      contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType ?? "")
        .split(";")[0]!
        .trim();
      const rawLength = response.headers["content-length"];
      declared = Array.isArray(rawLength) ? rawLength[0] ?? null : rawLength ?? null;
      bytes = response.bytes;
    }
    const extension = extensionFor(contentType);
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESULT_BYTES)) {
      throw new Error("result_too_large");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) {
      throw new Error("result_too_large");
    }
    await validateImageBytes({
      bytes,
      contentType: contentType as "image/jpeg" | "image/png" | "image/webp",
      maxBytes: MAX_RESULT_BYTES,
    });
    return await withTemporaryFile({
      category: "downloads",
      sessionFingerprint: input.jobId,
      extension,
      bytes,
      ...(input.storageConfig ? { config: input.storageConfig } : {}),
      operation: async (path) => {
        const safeBytes = await readFile(path);
        const safeJobId = input.jobId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
        return new Response(safeBytes, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(safeBytes.byteLength),
            "Content-Disposition": `attachment; filename="higgsfield-${safeJobId}.${extension}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
