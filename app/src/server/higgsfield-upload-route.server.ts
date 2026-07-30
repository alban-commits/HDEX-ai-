import { ApiJobError } from "@higgsfield/fnf/errors";
import { higgsfieldOAuthSessionFingerprint } from "./higgsfield-oauth.server";
import { uploadHiggsfieldImage } from "./higgsfield-media.server";
import {
  appendOAuthSessionCookies,
  clearAllOAuthCookies,
  requireActiveOAuthSession,
} from "./oauth-routes.server";
import { jsonNoStore, NO_STORE_HEADERS, rejectCrossSiteMutation } from "./http.server";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-request-security";
import {
  getHiggsfieldCapabilityRecord,
  inspectHiggsfieldCapabilities,
} from "./higgsfield-mcp.server";
import { readFile } from "node:fs/promises";
import { normalizeHiggsfieldUploadImage } from "./image-validation.server";
import { withTemporaryFile } from "./temporary-storage.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "./higgsfield-reconnect.server";

export async function handleHiggsfieldUpload(request: Request): Promise<Response> {
  const active = await requireActiveOAuthSession(request);
  if (!active) {
    const headers = new Headers(NO_STORE_HEADERS);
    clearAllOAuthCookies(headers);
    return jsonNoStore(
      {
        ok: false,
        error: {
          code: "oauth_required",
          message: "내 Higgsfield 계정을 연결해 주세요.",
          data: { reconnectRequired: true },
        },
      },
      { status: 401, headers },
    );
  }
  const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
  if (crossSite) return crossSite;
  const headers = new Headers(NO_STORE_HEADERS);
  if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
  const fingerprint = higgsfieldOAuthSessionFingerprint(active.session);
  try {
    const declared = request.headers.get("content-length");
    if (declared && Number(declared) > MAX_UPLOAD_BYTES + 64 * 1024) {
      throw new ApiJobError("file_too_large", "이미지는 20MB 이하여야 합니다.", { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiJobError("invalid_file", "이미지를 선택해 주세요.", { status: 400 });
    }
    if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
      throw new ApiJobError("invalid_file_type", "JPG, PNG, WebP 이미지만 지원합니다.", {
        status: 415,
      });
    }
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new ApiJobError("file_too_large", "이미지는 20MB 이하여야 합니다.", { status: 413 });
    }
    const originalContentType = file.type as "image/jpeg" | "image/png" | "image/webp";
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    let normalized: Awaited<ReturnType<typeof normalizeHiggsfieldUploadImage>>;
    try {
      normalized = await normalizeHiggsfieldUploadImage({
        bytes: originalBytes,
        contentType: originalContentType,
        maxOriginalBytes: MAX_UPLOAD_BYTES,
      });
    } catch {
      throw new ApiJobError("invalid_file", "이미지 파일을 확인해 주세요.", { status: 400 });
    }
    if (!getHiggsfieldCapabilityRecord(fingerprint)) {
      await inspectHiggsfieldCapabilities({
        sessionFingerprint: fingerprint,
        mcpUrl: active.config.mcpUrl,
        accessToken: active.session.accessToken,
      });
    }
    const ref = await withTemporaryFile({
      category: "uploads",
      sessionFingerprint: fingerprint,
      extension: normalized.extension,
      bytes: normalized.bytes,
      operation: async (temporaryPath) =>
        uploadHiggsfieldImage({
          session: active.session,
          fingerprint,
          filename: normalized.normalized ? "normalized-image.png" : (file.name.slice(0, 200) || `upload.${normalized.extension}`),
          contentType: normalized.contentType,
          bytes: new Uint8Array(await readFile(temporaryPath)),
        }),
    });
    return jsonNoStore({ ok: true, ref }, { headers });
  } catch (error) {
    if (isHiggsfieldAuthenticationFailure(error)) {
      await invalidateHiggsfieldAuthentication({ headers, sessionFingerprint: fingerprint });
      return jsonNoStore(
        {
          ok: false,
          error: {
            code: "oauth_required",
            message: "Higgsfield 계정을 다시 연결해 주세요.",
            status: 401,
            data: { reconnectRequired: true },
          },
        },
        { status: 401, headers },
      );
    }
    const payload =
      error instanceof ApiJobError
        ? error.toJSON()
        : { code: "upload_failed", message: "이미지 업로드를 완료하지 못했습니다." };
    return jsonNoStore(
      { ok: false, error: payload },
      { status: payload.status ?? 500, headers },
    );
  }
}
