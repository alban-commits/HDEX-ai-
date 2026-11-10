import type { FnfAdapter } from "@higgsfield/fnf";
import type { MediaRef } from "@higgsfield/fnf/media";
import { errorFromJSON } from "@higgsfield/fnf/errors";
import { gptImage2, nanoBanana2, soulV2Image } from "@higgsfield/fnf/jobs";
import type { AssetSelection } from "@/components/asset-library";
import { MAX_UPLOAD_BYTES } from "./upload-request-security";
import { fetchAppJson } from "./app-api-response.browser";

export const PRESET_JOBS = [soulV2Image, gptImage2, nanoBanana2] as const;

type AdapterResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; status?: number; data?: unknown } };

type ReconnectListener = () => void;
const reconnectListeners = new Set<ReconnectListener>();

type HiggsfieldDisconnectResponse = {
  connected: false;
  transport: "mcp_oauth";
};

export type HiggsfieldCapabilitySummary = {
  status: "ready" | "partial";
  models: Array<{ key: string; name: string; ready: boolean; reason?: string }>;
};

type HiggsfieldCapabilityResponse =
  | { ok: true; capability: HiggsfieldCapabilitySummary }
  | { ok: false; reason: string; reconnectRequired?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiError(value: unknown): value is {
  code: string;
  message: string;
  status?: number;
  data?: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.status === undefined ||
      (Number.isSafeInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599))
  );
}

function isAdapterResponse(value: unknown, status: number): value is AdapterResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  const allowedKeys = value.ok
    ? new Set(["ok", "value", "__hdex_adapter_response"])
    : new Set(["ok", "error", "__hdex_adapter_response"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.ok) {
    return status >= 200 && status < 300 && Object.hasOwn(value, "value");
  }
  return isApiError(value.error);
}

function isHiggsfieldDisconnectResponse(
  value: unknown,
  status: number,
): value is HiggsfieldDisconnectResponse {
  return (
    status === 200 &&
    isRecord(value) &&
    value.connected === false &&
    value.transport === "mcp_oauth"
  );
}

function isHiggsfieldCapabilityResponse(
  value: unknown,
  status: number,
): value is HiggsfieldCapabilityResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return (
      status >= 400 &&
      typeof value.reason === "string" &&
      (value.reconnectRequired === undefined || typeof value.reconnectRequired === "boolean")
    );
  }
  if (status < 200 || status >= 300 || !isRecord(value.capability)) return false;
  const capability = value.capability;
  return (
    (capability.status === "ready" || capability.status === "partial") &&
    Array.isArray(capability.models) &&
    capability.models.every(
      (model) =>
        isRecord(model) &&
        typeof model.key === "string" &&
        typeof model.name === "string" &&
        typeof model.ready === "boolean" &&
        (model.reason === undefined || typeof model.reason === "string"),
    )
  );
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
  const failureStage = isRecord(error.data) && typeof error.data.failureStage === "string"
    ? error.data.failureStage
    : null;
  const rejectionClass = isRecord(error.data) && typeof error.data.rejectionClass === "string"
    ? error.data.rejectionClass
    : null;
  const responseShape = isRecord(error.data) && typeof error.data.responseShape === "string"
    ? error.data.responseShape
    : null;
  const diagnosticSuffix = [
    failureStage ? `단계: ${failureStage}` : null,
    rejectionClass ? `분류: ${rejectionClass}` : null,
    responseShape ? `응답: ${responseShape}` : null,
  ].filter(Boolean).join(", ");
  throw errorFromJSON({
    ...error,
    message:
      diagnosticSuffix && error.status
        ? `${error.message} (HTTP ${error.status}, ${diagnosticSuffix})`
        : error.message,
  });
}

export function subscribeHiggsfieldReconnect(listener: ReconnectListener): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

export function notifyHiggsfieldReconnectRequired(): void {
  for (const listener of reconnectListeners) listener();
}

export async function disconnectHiggsfieldOAuth(): Promise<void> {
  await fetchAppJson<HiggsfieldDisconnectResponse>({
    path: "/api/higgsfield/oauth/disconnect",
    init: { method: "DELETE", credentials: "include" },
    isEnvelope: isHiggsfieldDisconnectResponse,
    allowHeaderlessEnvelope: true,
  });
}

/** Verify the OAuth session against the live Higgsfield MCP tools and model catalog. */
export async function inspectHiggsfieldOAuthCapabilities(
  requiredModelKeys: readonly string[] = [],
): Promise<HiggsfieldCapabilitySummary> {
  const result = await fetchAppJson<HiggsfieldCapabilityResponse>({
    path: "/api/higgsfield/oauth/capabilities",
    init: { method: "POST", credentials: "include" },
    isEnvelope: isHiggsfieldCapabilityResponse,
    allowHeaderlessEnvelope: true,
  });
  if (!result.ok) {
    if (result.reconnectRequired || result.reason === "oauth_required") {
      notifyHiggsfieldReconnectRequired();
    }
    throw errorFromJSON({
      code: result.reason,
      message:
        result.reason === "oauth_required"
          ? "Higgsfield 계정을 다시 연결해 주세요."
          : "Higgsfield MCP 도구와 모델 연결을 확인하지 못했습니다.",
      data: { reconnectRequired: result.reconnectRequired === true },
    });
  }
  const required = new Set(requiredModelKeys);
  const unavailableModels = result.capability.models.filter(
    (model) => !model.ready && (required.size === 0 || required.has(model.key)),
  );
  const missingRequired = [...required].filter(
    (key) => !result.capability.models.some((model) => model.key === key && model.ready),
  );
  if (
    (required.size === 0 && result.capability.status !== "ready") ||
    unavailableModels.length > 0 ||
    missingRequired.length > 0
  ) {
    const unavailable = unavailableModels
      .map((model) => model.name)
      .join(", ");
    throw errorFromJSON({
      code: "higgsfield_models_unavailable",
      message: unavailable
        ? `현재 사용할 수 없는 Higgsfield 모델이 있습니다: ${unavailable}`
        : missingRequired.length
          ? "선택한 Higgsfield 모델 연결이 준비되지 않았습니다. 계정을 다시 연결해 주세요."
          : "Higgsfield 모델 연결이 준비되지 않았습니다.",
    });
  }
  return result.capability;
}

async function adapterCall(operation: string, data: object = {}): Promise<unknown> {
  const result = await fetchAppJson<AdapterResponse>({
    path: "/api/higgsfield/adapter",
    init: {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, data }),
    },
    isEnvelope: isAdapterResponse,
    allowHeaderlessEnvelope: true,
  });
  if (!result.ok) throwAdapterError(result.error);
  return result.value;
}

/** Browser-safe adapter: every provider operation crosses the same-origin Node route. */
export const fnfBrowserAdapter: FnfAdapter = {
  // Each explicit Generate submit receives a fresh single-use intent token.
  // The server coalesces only overlapping identical request hashes.
  confirm: async () => crypto.randomUUID(),
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

export type CurrentUser = { id: string; workspaceId?: string | null; accountEmail?: string };
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
  return `/api/higgsfield/oauth/connect?return=${encodeURIComponent(safeReturnPath)}&account=change`;
}

export function clearStaleHiggsfieldOAuthError(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("higgsfield") !== "error") return;
  url.searchParams.delete("higgsfield");
  url.searchParams.delete("reason");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function getHiggsfieldOAuthCallbackMessage(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("higgsfield") !== "error") return null;
  switch (url.searchParams.get("reason")) {
    case "state_invalid":
      return "Higgsfield 재연결이 완료되지 않았습니다. 계정 연결을 다시 시작해 주세요.";
    case "canceled":
      return "Higgsfield 계정 연결이 취소되었습니다.";
    case "timeout":
      return "Higgsfield 계정 연결 시간이 초과되었습니다. 다시 연결해 주세요.";
    default:
      return "Higgsfield 계정 연결에 실패했습니다. 다시 연결해 주세요.";
  }
}

type UploadResponse =
  | { ok: true; ref: MediaRef }
  | { ok: false; error: { code: string; message: string; status?: number; data?: unknown } };

function isUploadResponse(value: unknown, status: number): value is UploadResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  const allowedKeys = value.ok ? new Set(["ok", "ref"]) : new Set(["ok", "error"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!value.ok) return isApiError(value.error);
  return (
    status >= 200 &&
    status < 300 &&
    isRecord(value.ref) &&
    typeof value.ref.id === "string" &&
    typeof value.ref.type === "string"
  );
}

// Fourteen interactive references plus one eight-file batch job can coexist;
// keep a small bounded margin without evicting the active workspace.
const MAX_LOCAL_UPLOADS = 32;
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

/** Keep an influencer pose in this browser for GPT analysis only. */
export function stageLocalPoseAsset(file: File): AssetSelection {
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    throw errorFromJSON({
      code: "invalid_file_type",
      message: "JPG 또는 PNG 이미지만 선택할 수 있습니다.",
      status: 415,
    });
  }
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
    throw errorFromJSON({
      code: "file_too_large",
      message: "이미지는 20MB 이하여야 합니다.",
      status: 413,
    });
  }
  const mediaId = `local-pose-${crypto.randomUUID()}`;
  const objectUrl = URL.createObjectURL(file);
  rememberLocalUpload(mediaId, file, objectUrl);
  return {
    name: file.name,
    type: file.type,
    src: objectUrl,
    ref: { id: mediaId, type: "media_input" },
  };
}

export async function uploadAsset(file: File): Promise<AssetSelection> {
  const form = new FormData();
  form.set("file", file);
  const body = await fetchAppJson<UploadResponse>({
    path: "/api/media/upload",
    init: { method: "POST", credentials: "include", body: form },
    isEnvelope: isUploadResponse,
    allowHeaderlessEnvelope: true,
  });
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
