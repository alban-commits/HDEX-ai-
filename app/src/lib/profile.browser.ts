import { getLocalUploadFile, notifyHiggsfieldReconnectRequired } from "./fnf.browser";
import { fetchAppJson } from "./app-api-response.browser";

type ProfileRequest = {
  gender: "male" | "female";
  environment: string;
  scene: string;
  imageType: string;
  poseMediaId: string;
  referenceImageUrls: string[];
};

type ProfileResponse =
  | { ok: true; profile: Record<string, unknown> }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfileResponse(value: unknown, status: number): value is ProfileResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return status >= 200 && status < 300 && isRecord(value.profile);
  return typeof value.code === "string" && typeof value.message === "string";
}

export async function composeInfluencerProfile(input: { data: ProfileRequest }) {
  const file = getLocalUploadFile(input.data.poseMediaId);
  if (!file) {
    return {
      ok: false as const,
      code: "pose_file_unavailable",
      message: "포즈 이미지를 다시 선택해 주세요.",
    };
  }
  const form = new FormData();
  form.set("pose", file);
  form.set(
    "data",
    JSON.stringify({
      gender: input.data.gender,
      environment: input.data.environment,
      scene: input.data.scene,
      imageType: input.data.imageType,
      referenceImageUrls: input.data.referenceImageUrls,
    }),
  );
  const body = await fetchAppJson<ProfileResponse>({
    path: "/api/openai/profile",
    init: {
      method: "POST",
      credentials: "include",
      body: form,
    },
    isEnvelope: isProfileResponse,
  });
  if (!body.ok && body.code === "oauth_required") {
    notifyHiggsfieldReconnectRequired();
  }
  return body;
}
