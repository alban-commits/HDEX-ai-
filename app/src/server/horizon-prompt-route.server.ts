import { z } from "zod";
import { HORIZON_MAX_IMAGES, HORIZON_RATIOS, HORIZON_VIEWS } from "@/lib/horizon";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-request-security";
import { composeHorizonPrompt, type HorizonPromptImage } from "./horizon-prompt.server";
import { jsonNoStore, NO_STORE_HEADERS, rejectCrossSiteMutation } from "./http.server";
import { validateImageBytes } from "./image-validation.server";
import { appendOAuthSessionCookies, clearAllOAuthCookies, requireActiveOAuthSession } from "./oauth-routes.server";

const requestData = z.object({
  brief: z.string().max(8_000),
  ratio: z.enum(HORIZON_RATIOS),
  targetView: z.enum(HORIZON_VIEWS),
  categories: z.array(z.string().min(1).max(160)).min(1).max(HORIZON_MAX_IMAGES),
});

export const HORIZON_PROMPT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
export const HORIZON_PROMPT_MAX_DECLARED_BYTES = HORIZON_PROMPT_MAX_TOTAL_BYTES + 1024 * 1024;

type ActiveOAuthSession = NonNullable<Awaited<ReturnType<typeof requireActiveOAuthSession>>>;
type HorizonPromptRouteDependencies = {
  requireSession?: (request: Request) => Promise<ActiveOAuthSession | null>;
  composePrompt?: typeof composeHorizonPrompt;
  maxTotalBytes?: number;
  maxDeclaredBytes?: number;
  parseFormData?: (request: Request) => Promise<FormData>;
};

function tooLarge(headers: Headers): Response {
  return jsonNoStore(
    { ok: false, code: "payload_too_large", message: "참조 이미지 합계는 80MB 이하여야 합니다." },
    { status: 413, headers },
  );
}

export async function handleHorizonPrompt(
  request: Request,
  dependencies: HorizonPromptRouteDependencies = {},
): Promise<Response> {
  const headers = new Headers(NO_STORE_HEADERS);
  const active = await (dependencies.requireSession ?? requireActiveOAuthSession)(request);
  if (!active) {
    clearAllOAuthCookies(headers);
    return jsonNoStore({ ok: false, code: "oauth_required", message: "Higgsfield 계정으로 로그인한 뒤 이용해주세요." }, { status: 401, headers });
  }
  const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
  if (crossSite) return crossSite;
  if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
  const maxTotalBytes = dependencies.maxTotalBytes ?? HORIZON_PROMPT_MAX_TOTAL_BYTES;
  const maxDeclaredBytes = dependencies.maxDeclaredBytes ?? HORIZON_PROMPT_MAX_DECLARED_BYTES;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxDeclaredBytes) {
    return tooLarge(headers);
  }
  let parsed: { brief: string; ratio: (typeof HORIZON_RATIOS)[number]; targetView: (typeof HORIZON_VIEWS)[number]; categories: string[]; images: HorizonPromptImage[] };
  try {
    const form = await (dependencies.parseFormData?.(request) ?? request.formData());
    const rawData = form.get("data");
    if (typeof rawData !== "string") throw new Error("invalid_input");
    const data = requestData.parse(JSON.parse(rawData) as unknown);
    const files = form.getAll("image");
    if (files.length !== data.categories.length || files.length > HORIZON_MAX_IMAGES) throw new Error("invalid_input");
    let totalBytes = 0;
    for (const file of files) {
      if (!(file instanceof File)) throw new Error("invalid_image");
      totalBytes += file.size;
      if (totalBytes > maxTotalBytes) return tooLarge(headers);
    }
    const images: HorizonPromptImage[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!(file instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size === 0 || file.size > MAX_UPLOAD_BYTES) throw new Error("invalid_image");
      const bytes = new Uint8Array(await file.arrayBuffer());
      await validateImageBytes({ bytes, contentType: file.type as HorizonPromptImage["contentType"], maxBytes: MAX_UPLOAD_BYTES });
      images.push({ category: data.categories[index]!, bytes, contentType: file.type as HorizonPromptImage["contentType"] });
    }
    parsed = { brief: data.brief, ratio: data.ratio, targetView: data.targetView, categories: data.categories, images };
  } catch {
    return jsonNoStore({ ok: false, code: "invalid_input", message: "선택한 이미지와 입력값을 확인해 주세요." }, { status: 400, headers });
  }
  try {
    const result = await (dependencies.composePrompt ?? composeHorizonPrompt)({ brief: parsed.brief, ratio: parsed.ratio, targetView: parsed.targetView, images: parsed.images });
    return jsonNoStore(result, { status: result.ok ? 200 : 502, headers });
  } catch {
    return jsonNoStore({ ok: false, code: "provider_error", message: "GPT 명령어 작성 요청에 실패했습니다." }, { status: 502, headers });
  }
}
