import type { FnfAdapter } from "@higgsfield/fnf";
import type { MediaRef } from "@higgsfield/fnf/media";
import { errorFromJSON } from "@higgsfield/fnf/errors";
import { gptImage2, soulV2Image } from "@higgsfield/fnf/jobs";
import type { AssetSelection } from "@/components/asset-library";

export const PRESET_JOBS = [soulV2Image, gptImage2] as const;

type AdapterResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; status?: number; data?: unknown } };

type ReconnectListener = () => void;
const reconnectListeners = new Set<ReconnectListener>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresReconnect(error: { code: string; data?: unknown }): boolean {
  return (
    error.code === "oauth_required" ||
    (isRecord(error.data) && error.data.reconnectRequired === true)
  );
}

function throwAdapterError(error: {
  code: string;
  message: string;
  status?: number;
  data?: unknown;
}): never {
  if (requiresReconnect(error)) {
    notifyHiggsfieldReconnectRequired();
  }
  throw errorFromJSON(error);
}

export function subscribeHiggsfieldReconnect(listener: ReconnectListener): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

export function notifyHiggsfieldReconnectRequired(): void {
  for (const listener of reconnectListeners) listener();
}

async function adapterCall(operation: string, data: object = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/higgsfield/adapter", {
      method: "POST",
      credentials: "include",
      redirect: "manual",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ operation, data }),
    });
  } catch {
    throwAdapterError({
      code: "adapter_request_failed",
      message: "서버 연결 요청을 완료하지 못했습니다.",
    });
  }
  if (
    response.status === 0 ||
    response.type === "opaqueredirect" ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    throwAdapterError({
      code: "access_session_required",
      message: "사내 접근 세션을 확인해 주세요.",
      status: response.status || undefined,
    });
  }
  const successfulStatus = response.status >= 200 && response.status < 300;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throwAdapterError({
      code: "adapter_non_json_response",
      message: "서버가 올바른 API 응답을 반환하지 않았습니다.",
      status: response.status || undefined,
    });
  }
  let result: AdapterResponse;
  try {
    result = (await response.json()) as AdapterResponse;
  } catch {
    throwAdapterError({
      code: "adapter_invalid_json_response",
      message: "서버 API 응답을 확인하지 못했습니다.",
      status: response.status || undefined,
    });
  }
  if (
    !isRecord(result) ||
    typeof result.ok !== "boolean" ||
    (result.ok === false &&
      (!isRecord(result.error) ||
        typeof result.error.code !== "string" ||
        typeof result.error.message !== "string"))
  ) {
    throwAdapterError({
      code: "adapter_invalid_json_response",
      message: "서버 API 응답을 확인하지 못했습니다.",
      status: response.status || undefined,
    });
  }
  if (result.ok && !successfulStatus) {
    throwAdapterError({
      code: "adapter_http_error",
      message: "서버 API 요청이 실패했습니다.",
      status: response.status,
    });
  }
  if (!result.ok) throwAdapterError(result.error);
  return result.value;
}

/** Browser-safe adapter: every provider operation crosses the same-origin Node route. */
export const fnfBrowserAdapter: FnfAdapter = {
  // The existing Generate button is the explicit user action. This opaque ID
  // lets the server atomically deduplicate that exact built request without
  // adding a second confirmation UI.
  confirm: () => Promise.resolve(crypto.randomUUID()),
  createJobs: (data) => adapterCall("createJobs", data),
  getJob: (id) => adapterCall("getJob", { id }),
  listJobs: (data) => adapterCall("listJobs", data),
  estimateCost: (data) => adapterCall("estimateCost", data),
  getMedia: () =>
    Promise.reject(errorFromJSON({ code: "not_supported", message: "Not supported" })),
  listMedia: () => Promise.resolve({ items: [] }),
  getUser: () => adapterCall("getUser"),
  listWorkspaces: () => adapterCall("listWorkspaces"),
  getCurrentWorkspace: () => adapterCall("getCurrentWorkspace"),
  getWorkspaceWallet: () => adapterCall("getWorkspaceWallet"),
  switchWorkspace: (data) => adapterCall("switchWorkspace", data),
};

type CurrentUser = { id: string; workspaceId?: string | null };
export const GUEST_SCOPE_KEY = "guest";

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const response = await fetch("/api/user", { credentials: "include" });
    if (response.status === 401 || !response.ok) return null;
    return (await response.json()) as CurrentUser;
  } catch {
    return null;
  }
}

/** Resolve the identity boundary used by every browser-side Preset cache. */
export async function getFnfScopeKey(): Promise<string> {
  const user = await fetchCurrentUser();
  if (user == null) return GUEST_SCOPE_KEY;
  return `${user.id}:${user.workspaceId ?? "personal"}`;
}

export function getSignInUrl(scopeKey: string, returnPath: string): string | null {
  if (scopeKey !== GUEST_SCOPE_KEY) return null;
  const safeReturnPath =
    returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  return `/api/higgsfield/oauth/connect?return=${encodeURIComponent(safeReturnPath)}`;
}

export function getReconnectSignInUrl(returnPath: string): string {
  const safeReturnPath =
    returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  return `/api/higgsfield/oauth/connect?return=${encodeURIComponent(safeReturnPath)}`;
}

type UploadResponse =
  | { ok: true; ref: MediaRef }
  | { ok: false; error: { code: string; message: string; status?: number; data?: unknown } };

const MAX_LOCAL_UPLOADS = 8;
const localUploadFiles = new Map<string, { file: File; objectUrl: string }>();

export function getLocalUploadFile(mediaId: string): File | undefined {
  return localUploadFiles.get(mediaId)?.file;
}

export function releaseLocalUpload(mediaId: string): void {
  const stored = localUploadFiles.get(mediaId);
  if (!stored) return;
  localUploadFiles.delete(mediaId);
  URL.revokeObjectURL(stored.objectUrl);
}

export function releaseAllLocalUploads(): void {
  for (const mediaId of [...localUploadFiles.keys()]) releaseLocalUpload(mediaId);
}

function rememberLocalUpload(mediaId: string, file: File, objectUrl: string): void {
  releaseLocalUpload(mediaId);
  localUploadFiles.set(mediaId, { file, objectUrl });
  while (localUploadFiles.size > MAX_LOCAL_UPLOADS) {
    const oldest = localUploadFiles.keys().next().value as string | undefined;
    if (!oldest) break;
    releaseLocalUpload(oldest);
  }
}

export async function uploadAsset(file: File): Promise<AssetSelection> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/media/upload", { method: "POST", body: form });
  const body = (await response.json()) as UploadResponse;
  if (!body.ok) throwAdapterError(body.error);
  const objectUrl = URL.createObjectURL(file);
  rememberLocalUpload(body.ref.id, file, objectUrl);
  return {
    name: file.name,
    type: file.type || body.ref.type,
    src: objectUrl,
    ref: { ...body.ref, type: "media_input" },
  };
}
