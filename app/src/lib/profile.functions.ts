import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "@/lib/bindings.server";
import { BASE_PROFILE } from "@/data/base-profile";
import { requireCurrentUser } from "@/lib/auth.server";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const inputSchema = z.object({
  gender: z.enum(["male", "female"]),
  environment: z.string().min(1).max(100),
  scene: z.string().min(1).max(160),
  imageType: z.string().min(1).max(80),
  poseImageUrl: z.string().url().max(2048),
  referenceImageUrls: z.array(z.string().url().max(2048)).max(6),
});

function safeImageUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "cdn.higgsfield.ai" ||
    host === "upload.higgsfield.ai" ||
    host === "upload-dev.higgsfield.ai" ||
    host.endsWith(".cloudfront.net");
  if (url.protocol !== "https:" || !allowed) throw new Error("지원되지 않는 포즈 이미지 주소입니다.");
  return url.toString();
}

function safeReferenceImageUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.pathname.startsWith("/references/")) {
    throw new Error("지원되지 않는 폴더 레퍼런스 주소입니다.");
  }
  return url.toString();
}

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

export const composeInfluencerProfile = createServerFn({ method: "POST" })
  .validator(inputSchema)
  .handler(async ({ data }) => {
    const auth = await requireCurrentUser();
    if (!auth.ok) {
      return {
        ok: false as const,
        code: "unauthorized",
        message: "Higgsfield 계정으로 로그인한 뒤 이용해주세요.",
      };
    }
    const apiKey = bindings().OPENAI_API_KEY;
    if (!apiKey) {
      return {
        ok: false as const,
        code: "missing_openai_api_key",
        message: "배포 설정에 OPENAI_API_KEY를 입력해야 GPT JSON 생성을 사용할 수 있습니다.",
      };
    }

    const genderDirection =
      data.gender === "male"
        ? "a genuinely fit Korean male influencer in his twenties, ruggedly handsome, masculine and naturally confident"
        : "a genuinely fit Korean female influencer in her twenties, naturally attractive, healthy, energetic and confident";
    const instruction = [
      "Create one complete JSON object using the supplied BASE JSON as the exact structural template.",
      `Subject: ${genderDirection}.`,
      `Environment category: ${data.environment}. Scene/action category: ${data.scene}.`,
      `Image treatment: ${data.imageType}.`,
      "Analyze the supplied pose image ONLY for body orientation, weight distribution, head direction, gaze, arms, hands, legs, feet, camera viewpoint and crop. Do not copy identity, face, clothes, text, background or layout.",
      "The resulting master_prompt is for Higgsfield Soul 2 text-to-image. Exactly one person appears exactly once in one continuous undivided photograph.",
      "No split screen, collage, repeated subject, contact sheet, social-media interface, text, logo, watermark or readable signage.",
      "Keep the setting and action faithful to the selected categories but allow natural location and pose variation that real Korean influencers would post.",
      "Use English for every generated prompt string. Return JSON only.",
      `BASE JSON:\n${JSON.stringify(BASE_PROFILE)}`,
    ].join("\n\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              { type: "input_image", image_url: safeImageUrl(data.poseImageUrl), detail: "high" },
              ...data.referenceImageUrls.map((imageUrl) => ({
                type: "input_image" as const,
                image_url: safeReferenceImageUrl(imageUrl),
                detail: "high" as const,
              })),
            ],
          },
        ],
        text: { format: { type: "json_object" } },
      }),
    });

    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      return {
        ok: false as const,
        code: "openai_error",
        message: "GPT JSON 생성 요청에 실패했습니다. API 키와 사용 한도를 확인해주세요.",
      };
    }
    const text = extractOutputText(payload);
    try {
      const profile = JSON.parse(text) as JsonObject;
      if (typeof profile.master_prompt !== "string" || !profile.master_prompt.trim()) {
        throw new Error("missing master_prompt");
      }
      return { ok: true as const, profile };
    } catch {
      return {
        ok: false as const,
        code: "invalid_profile",
        message: "GPT가 올바른 JSON을 반환하지 않았습니다. 다시 시도해주세요.",
      };
    }
  });
