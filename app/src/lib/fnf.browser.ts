import type { FnfAdapter } from "@higgsfield/fnf";
import type { MediaRef } from "@higgsfield/fnf/media";
import { errorFromJSON } from "@higgsfield/fnf/errors";
import { gptImage2, nanoBanana2, soulV2Image } from "@higgsfield/fnf/jobs";
import type { AssetSelection } from "@/components/asset-library";
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

export async function disconnectHiggsfieldOAuth(): Promise<void> {
  await fetchAppJson<HiggsfieldDisconnectResponse>({
    path: "/api/higgsfield/oauth/disconnect",
    init: { method: "DELETE", credentials: "include" },
    isEnvelope: isHiggsfieldDisconnectResponse,
  });
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
    allowHeaderlessAdapterError: true,
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

function isUploadResponse(value: unknown, status: number): value is UploadResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
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

export async function uploadAsset(file: File): Promise<AssetSelection> {
  const form = new FormData();
  form.set("file", file);
  const body = await fetchAppJson<UploadResponse>({
    path: "/api/media/upload",
    init: { method: "POST", credentials: "include", body: form },
    isEnvelope: isUploadResponse,
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
