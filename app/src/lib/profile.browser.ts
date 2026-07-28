import { errorFromJSON } from "@higgsfield/fnf/errors";
import { getLocalUploadFile, notifyHiggsfieldReconnectRequired } from "./fnf.browser";

type ProfileRequest = {
  gender: "male" | "female";
  environment: string;
  scene: string;
  imageType: string;
  poseMediaId: string;
  referenceImageUrls: string[];
};

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
  const response = await fetch("/api/openai/profile", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const body = (await response.json()) as
    { ok: true; profile: Record<string, unknown> } | { ok: false; code: string; message: string };
  if (response.status === 401 || (!body.ok && body.code === "oauth_required")) {
    notifyHiggsfieldReconnectRequired();
  }
  if (!response.ok && body.ok)
    throw errorFromJSON({ code: "openai_error", message: "Request failed" });
  return body;
}
