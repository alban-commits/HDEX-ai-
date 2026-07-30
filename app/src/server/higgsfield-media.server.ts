import { ApiJobError } from "@higgsfield/fnf/errors";
import { callHiggsfieldMcpTool, requireDiscoveredModel } from "./higgsfield-mcp.server";
import type { HiggsfieldOAuthSession } from "./higgsfield-oauth.server";
import { requestPinnedHttps } from "./pinned-https.server";
import { registerGenerationMedia } from "./generation-attempt-store.server";

const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,240}$/.test(value) ? value : null;
}

function safeSignedUploadUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function uploadHiggsfieldImage(input: {
  session: HiggsfieldOAuthSession;
  fingerprint: string;
  filename: string;
  contentType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  callTool?: (
    name: "media_upload" | "media_confirm",
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  uploadFetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ id: string; type: "image" }> {
  // 업로드 전에 현재 앱이 승인한 이미지 모델 중 하나라도 실행 가능해야 한다.
  let ready = false;
  for (const key of ["gpt_image_2", "soul_2", "nano_banana_pro"] as const) {
    try { requireDiscoveredModel(input.fingerprint, key); ready = true; break; } catch {}
  }
  if (!ready) requireDiscoveredModel(input.fingerprint, "gpt_image_2");
  const callTool =
    input.callTool ??
    ((name, args) => callHiggsfieldMcpTool({ session: input.session, name, args }));
  const reservation = await callTool("media_upload", {
    method: "upload_url",
    files: [{ filename: input.filename, content_type: input.contentType }],
  });
  if (!Array.isArray(reservation.uploads) || reservation.uploads.length !== 1) {
    throw new ApiJobError("invalid_response", "Higgsfield 업로드 응답이 올바르지 않습니다.", {
      status: 502,
    });
  }
  const upload = reservation.uploads[0];
  if (!isRecord(upload)) {
    throw new ApiJobError("invalid_response", "Higgsfield 업로드 응답이 올바르지 않습니다.", {
      status: 502,
    });
  }
  const mediaId = safeId(upload.media_id);
  const uploadUrl = safeSignedUploadUrl(upload.upload_url);
  if (
    !mediaId ||
    !uploadUrl ||
    upload.content_type !== input.contentType ||
    String(upload.method).toUpperCase() !== "PUT"
  ) {
    throw new ApiJobError("invalid_response", "Higgsfield 업로드 계보를 확인할 수 없습니다.", {
      status: 502,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    if (input.uploadFetch) {
      const response = await input.uploadFetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        body: new Blob([input.bytes as BlobPart], { type: input.contentType }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiJobError("media_upload_failed", "Higgsfield 이미지 전송에 실패했습니다.", {
          status: 502,
        });
      }
      await response.body?.cancel();
    } else {
      const response = await requestPinnedHttps({
        url: uploadUrl,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        body: input.bytes,
        maxResponseBytes: MAX_UPLOAD_RESPONSE_BYTES,
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new ApiJobError("media_upload_failed", "Higgsfield 이미지 전송에 실패했습니다.", {
          status: 502,
        });
      }
    }
  } catch (error) {
    if (error instanceof ApiJobError) throw error;
    throw new ApiJobError(
      controller.signal.aborted ? "timeout" : "media_upload_failed",
      controller.signal.aborted
        ? "Higgsfield 이미지 전송 시간이 초과됐습니다."
        : "Higgsfield 이미지 전송에 실패했습니다.",
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  const confirmed = await callTool("media_confirm", {
    media_ids: [mediaId],
    type: "image",
  });
  if (!Array.isArray(confirmed.results) || confirmed.results.length !== 1) {
    throw new ApiJobError("invalid_response", "Higgsfield 이미지 확정 응답이 올바르지 않습니다.", {
      status: 502,
    });
  }
  const result = confirmed.results[0];
  const acceptedStatuses = new Set(["uploaded", "confirmed", "ready", "completed", "success"]);
  if (
    !isRecord(result) ||
    safeId(result.media_id) !== mediaId ||
    typeof result.status !== "string" ||
    !acceptedStatuses.has(result.status.trim().toLowerCase())
  ) {
    throw new ApiJobError("invalid_response", "Higgsfield 이미지 확정 계보가 일치하지 않습니다.", {
      status: 502,
    });
  }
  await registerGenerationMedia({
    sessionFingerprint: input.fingerprint,
    mediaId,
    env: input.env,
    now: input.now,
  });
  return { id: mediaId, type: "image" };
}
