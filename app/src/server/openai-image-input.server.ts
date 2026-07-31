import { Buffer } from "node:buffer";
import { readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { validateImageBytes } from "./image-validation.server";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_OPENAI_RESPONSE_BYTES = 1024 * 1024;
const OPENAI_TIMEOUT_MS = 60_000;

type ImageContentType = "image/jpeg" | "image/png" | "image/webp";
export type OpenAiPostFailure = "timeout" | "transport" | "http" | "invalid_response";
export type OpenAiPostResult =
  | { ok: true; payload: unknown }
  | { ok: false; payload: unknown; failure: OpenAiPostFailure };

function mimeForPath(path: string): ImageContentType {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  throw new Error("지원되지 않는 폴더 레퍼런스 형식입니다.");
}

async function readReferenceImage(
  value: string,
  publicOrigin: string,
  publicDirectory: string,
): Promise<{ bytes: Uint8Array; contentType: ImageContentType }> {
  const url = new URL(value);
  if (
    url.origin !== publicOrigin ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/references/")
  ) {
    throw new Error("지원되지 않는 폴더 레퍼런스 주소입니다.");
  }
  const root = await realpath(resolve(publicDirectory, "references"));
  const decodedPath = decodeURIComponent(url.pathname.slice("/references/".length));
  const candidate = await realpath(resolve(root, decodedPath));
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || resolve(root, pathFromRoot) !== candidate) {
    throw new Error("지원되지 않는 폴더 레퍼런스 주소입니다.");
  }
  const bytes = new Uint8Array(await readFile(candidate));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("폴더 레퍼런스 이미지 크기를 확인해 주세요.");
  }
  const contentType = mimeForPath(candidate);
  await validateImageBytes({ bytes, contentType, maxBytes: MAX_REFERENCE_BYTES });
  return { bytes, contentType };
}

export function imageDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function localReferenceDataUrls(input: {
  values: string[];
  publicOrigin: string;
  publicDirectory?: string;
}): Promise<string[]> {
  const images = await Promise.all(
    input.values.map((value) =>
      readReferenceImage(
        value,
        input.publicOrigin,
        input.publicDirectory ?? resolve(process.cwd(), "public"),
      ),
    ),
  );
  return images.map((image) => imageDataUrl(image.bytes, image.contentType));
}

async function readOpenAiJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_OPENAI_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("openai_response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_OPENAI_RESPONSE_BYTES) {
    throw new Error("openai_response_too_large");
  }
  return JSON.parse(text) as unknown;
}

export async function postOpenAiJson(input: {
  apiKey: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OpenAiPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? OPENAI_TIMEOUT_MS);
  try {
    const response = await (input.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await readOpenAiJson(response);
    } catch {
      return { ok: false, payload: null, failure: "invalid_response" };
    }
    return response.ok
      ? { ok: true, payload }
      : { ok: false, payload, failure: "http" };
  } catch {
    return {
      ok: false,
      payload: null,
      failure: controller.signal.aborted ? "timeout" : "transport",
    };
  } finally {
    clearTimeout(timer);
  }
}
