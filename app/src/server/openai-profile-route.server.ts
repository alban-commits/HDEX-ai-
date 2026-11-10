import { resolve } from "node:path";
import { z } from "zod";
import { composeInfluencerProfile } from "@/lib/profile.functions";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-request-security";
import {
  appendOAuthSessionCookies,
  clearAllOAuthCookies,
  requireActiveOAuthSession,
} from "./oauth-routes.server";
import { jsonNoStore, NO_STORE_HEADERS, rejectCrossSiteMutation } from "./http.server";
import { validateImageBytes } from "./image-validation.server";

const profileInput = z.object({
  gender: z.enum(["male", "female"]),
  environment: z.string().min(1).max(100),
  scene: z.string().min(1).max(160),
  imageType: z.string().min(1).max(80),
  referenceImageUrls: z.array(z.string().url().max(2048)).max(6),
});

export async function handleOpenAiProfile(request: Request): Promise<Response> {
  const active = await requireActiveOAuthSession(request);
  if (!active) {
    const headers = new Headers(NO_STORE_HEADERS);
    clearAllOAuthCookies(headers);
    return jsonNoStore(
      {
        ok: false,
        code: "oauth_required",
        message: "Higgsfield 계정으로 로그인한 뒤 이용해주세요.",
      },
      { status: 401, headers },
    );
  }
  const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
  if (crossSite) return crossSite;
  const headers = new Headers(NO_STORE_HEADERS);
  if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
  try {
    const declared = request.headers.get("content-length");
    if (declared && Number(declared) > MAX_UPLOAD_BYTES + 64 * 1024) {
      return jsonNoStore(
        { ok: false, code: "file_too_large", message: "이미지는 20MB 이하여야 합니다." },
        { status: 413, headers },
      );
    }
    const form = await request.formData();
    const pose = form.get("pose");
    const rawData = form.get("data");
    if (!(pose instanceof File) || typeof rawData !== "string") throw new Error("invalid_input");
    if (
      (pose.type !== "image/jpeg" && pose.type !== "image/png") ||
      pose.size === 0 ||
      pose.size > MAX_UPLOAD_BYTES
    ) {
      throw new Error("invalid_pose");
    }
    const poseBytes = new Uint8Array(await pose.arrayBuffer());
    await validateImageBytes({
      bytes: poseBytes,
      contentType: pose.type,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    const data = profileInput.parse(JSON.parse(rawData) as unknown);
    const result = await composeInfluencerProfile({
      data,
      pose: {
        bytes: poseBytes,
        contentType: pose.type,
      },
      publicOrigin: active.config.publicOrigin,
      publicDirectory: resolve(process.cwd(), "public"),
    });
    return jsonNoStore(result, { status: result.ok ? 200 : 502, headers });
  } catch {
    return jsonNoStore(
      { ok: false, code: "invalid_input", message: "입력 이미지를 확인해 주세요." },
      { status: 400, headers },
    );
  }
}
