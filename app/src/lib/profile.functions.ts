import { bindings } from "@/lib/bindings.server";
import { BASE_PROFILE } from "@/data/base-profile";
import {
  imageDataUrl,
  localReferenceDataUrls,
  postOpenAiJson,
} from "@/server/openai-image-input.server";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type InfluencerProfileInput = {
  gender: "male" | "female";
  environment: string;
  scene: string;
  imageType: string;
  referenceImageUrls: string[];
};

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") return direct;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return "";
}

export async function composeInfluencerProfile(input: {
  data: InfluencerProfileInput;
  pose: { bytes: Uint8Array; contentType: "image/jpeg" | "image/png" };
  publicOrigin: string;
  publicDirectory?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}): Promise<
  | { ok: true; profile: JsonObject }
  | { ok: false; code: string; message: string }
> {
  const apiKey = input.apiKey ?? bindings().OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      code: "missing_openai_api_key",
      message: "배포 설정에 OPENAI_API_KEY를 입력해야 GPT JSON 생성을 사용할 수 있습니다.",
    };
  }
  const referenceImageUrls = await localReferenceDataUrls({
    values: input.data.referenceImageUrls,
    publicOrigin: input.publicOrigin,
    publicDirectory: input.publicDirectory,
  });

  const genderDirection =
    input.data.gender === "male"
      ? "a genuinely fit Korean male influencer in his twenties, ruggedly handsome, masculine and naturally confident"
      : "a genuinely fit Korean female influencer in her twenties, naturally attractive, healthy, energetic and confident";
  const instruction = [
    "Create one complete JSON object using the supplied BASE JSON as the exact structural template.",
    `Subject: ${genderDirection}.`,
    `Environment category: ${input.data.environment}. Scene/action category: ${input.data.scene}.`,
    `Image treatment: ${input.data.imageType}.`,
    "Analyze the supplied pose image ONLY for body orientation, weight distribution, head direction, gaze, arms, hands, legs, feet, camera viewpoint and crop. Do not copy identity, face, clothes, text, background or layout.",
    "The resulting master_prompt is for Higgsfield Soul 2 text-to-image. Exactly one person appears exactly once in one continuous undivided photograph.",
    "No split screen, collage, repeated subject, contact sheet, social-media interface, text, logo, watermark or readable signage.",
    "Keep the setting and action faithful to the selected categories but allow natural location and pose variation that real Korean influencers would post.",
    "Use English for every generated prompt string. Return JSON only.",
    `BASE JSON:\n${JSON.stringify(BASE_PROFILE)}`,
  ].join("\n\n");

  const response = await postOpenAiJson({
    apiKey,
    fetchImpl: input.fetchImpl,
    body: {
      model: "gpt-5.6-terra",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instruction },
            {
              type: "input_image",
              image_url: imageDataUrl(input.pose.bytes, input.pose.contentType),
              detail: "high",
            },
            ...referenceImageUrls.map((imageUrl) => ({
              type: "input_image" as const,
              image_url: imageUrl,
              detail: "high" as const,
            })),
          ],
        },
      ],
      text: { format: { type: "json_object" } },
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      code: "openai_error",
      message: "GPT JSON 생성 요청에 실패했습니다. API 키와 사용 한도를 확인해주세요.",
    };
  }
  const text = extractOutputText(response.payload);
  try {
    const profile = JSON.parse(text) as JsonObject;
    if (typeof profile.master_prompt !== "string" || !profile.master_prompt.trim()) {
      throw new Error("missing master_prompt");
    }
    return { ok: true, profile };
  } catch {
    return {
      ok: false,
      code: "invalid_profile",
      message: "GPT가 올바른 JSON을 반환하지 않았습니다. 다시 시도해주세요.",
    };
  }
}
