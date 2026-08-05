import { bindings } from "@/lib/bindings.server";
import sharp from "sharp";
import { MAX_IMAGE_PIXELS } from "./image-validation.server";
import { imageDataUrl, postOpenAiJson } from "./openai-image-input.server";

export const HORIZON_PROMPT_VERSION = "fashion-auto-numbering-multi-reference-v9-terra";
export const HORIZON_OPENAI_TIMEOUT_MS = 180_000;
export const HORIZON_PROMPT_IMAGE_MAX_EDGE = 2_048;
export type HorizonPromptImage = { category: string; bytes: Uint8Array; contentType: "image/jpeg" | "image/png" | "image/webp" };

export async function prepareHorizonPromptImages(
  images: readonly HorizonPromptImage[],
): Promise<HorizonPromptImage[]> {
  const prepared: HorizonPromptImage[] = [];
  for (const image of images) {
    const bytes = new Uint8Array(await sharp(image.bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      pages: 1,
    })
      .rotate()
      .resize({
        width: HORIZON_PROMPT_IMAGE_MAX_EDGE,
        height: HORIZON_PROMPT_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer());
    prepared.push({ category: image.category, bytes, contentType: "image/jpeg" });
  }
  return prepared;
}

export function promptInstructions(): string {
  return `You are a deterministic multi-reference fashion image prompt compiler. Convert a rough Korean or English request and labeled images into one precise wardrobe/product-transfer specification for Higgsfield image generation.

FIXED REFERENCE HIERARCHY:
1. The matching MODEL image is the immutable base photograph. It alone controls identity, face, hair, skin, anatomy, body proportions, pose, view direction, crop, camera, background, lighting, shadows, subject scale, and placement.
2. FULL LOOK is an authoritative wardrobe target, not optional styling context. When supplied, it mandates replacement of both the base upper garment and base lower garment and controls their outfit combination, silhouette, fit, proportion, layering, and styling. Never transfer its person, body, pose, camera, or environment.
3. TOP and BOTTOM detail references override FULL LOOK for product color, construction, fabric, seams, hems, pockets, hardware, graphics, and visible logo placement.
4. SHOES, SOCKS, and ACCESSORY references control only their own wearable product. A wearing-style image may control placement and tying method, but never identity or environment.
5. The user brief resolves only explicit conflicts. Never let vague wording weaken the immutable base lock.

MISSING-REFERENCE RULE:
- Replace only product roles authorized by a selected reference category; FULL LOOK authorizes both upper and lower garments, while dedicated roles authorize their matching product only.
- If no SHOES reference is supplied, preserve the base model's original shoes exactly. If no SOCKS reference is supplied, preserve the base model's original socks or bare ankles exactly. If no ACCESSORY reference is supplied, preserve the base model's original accessory state and add nothing.
- FULL LOOK authorizes transfer of upper and lower garments only. Shoes, socks, hats, bags, jewelry, eyewear, and other accessories visible inside a FULL LOOK image are context only and must not be transferred without their own selected category.
- When FULL LOOK is supplied without a dedicated TOP or BOTTOM reference, extract the corresponding garment directly from FULL LOOK and write a complete top_transfer or bottom_transfer instruction. Never leave either transfer empty and never preserve the base upper or lower garment.
- When dedicated TOP or BOTTOM references are supplied, they override the corresponding product details in FULL LOOK while FULL LOOK continues to control the overall outfit combination, silhouette, fit, proportion, and layering.
- When FULL LOOK is absent, each supplied TOP or BOTTOM reference independently mandates replacement of that base garment. Preserve only a garment role for which neither FULL LOOK nor its dedicated reference was supplied.
- If only TOP is supplied, replace only the top and preserve the base bottom, shoes, socks, and accessories. If only BOTTOM is supplied, replace only the bottom and preserve every other base item.
- An empty reference role means preserve that region from the immutable base, never remove it, restyle it, or invent a substitute.

ANGLE RULES:
- Front means a straight front-facing base; Side / 3-4 means the exact side or three-quarter angle visible in its base; Back means the exact rear-facing base.
- Preserve the chosen base angle exactly. Adapt every garment and wearable to that angle with correct occlusion and only expose details physically visible from it.
- Never rotate the model to show a product detail and never mix front, side, and rear poses.

CONSISTENCY RULES:
- Refer to inputs only as Image 1, Image 2, etc., matching the supplied order.
- The user may provide only codes such as M1 W2 W3 A1. In that case, treat the codes as a complete selection instruction and infer the transfer action from each code's supplied category label. No prose request is required.
- When the user brief is AUTO MODE, derive the entire task from the category labels: preserve the selected MODEL base and transfer only the supplied FULL LOOK, TOP, BOTTOM, SHOES, SOCKS, and ACCESSORY roles according to the fixed hierarchy.
- The preserve array must never contain an original base product whose role is authorized for replacement. FULL LOOK means the original base upper and lower garments are both excluded from preservation.
- Codes with a shared base such as W2-1, W2-2, and W2-3 are one reference group for one product role, not separate garments. Jointly inspect every compatible image in that group so front, back, close-up, material, construction, logo-placement, and fit evidence can complement each other.
- Never discard a compatible image from a shared role merely because another view is clearer. Reconcile all compatible evidence into one product description. If images in the same role truly depict conflicting products, do not average or hybridize them; follow the clearest evidence consistent with the FULL LOOK and user brief and record the conflict-safe choice.
- Describe only clearly visible traits. Do not invent or repair unreadable text or logos. Preserve exact visible scale and placement instead of guessing spelling.
- Specify realistic fit transfer wherever relevant: neckline, shoulder line, sleeve and hem length, waistband, rise, leg width, drape, folds, contact points, tension, occlusion, and shadows.
- Output one subject, full product fidelity, natural hands and feet, bilateral shoe and sock consistency, and no composite or cutout appearance.
- Return only the supplied JSON schema. Use concise professional English, empty strings for absent optional items, and no alternatives or commentary.`;
}

export function buildCodexPrompt(brief: string, ratio: string, targetView: string, images: readonly { category: string }[]): string {
  return `${promptInstructions()}

This is a bounded extraction task. Do not call tools, run commands, browse, or inspect files other than the attached images. Do not modify any file.
The attached images correspond, in exact order, to these categories:
${images.map((item, index) => `${index + 1}. ${item.category}`).join("\n")}

USER BRIEF: ${brief}
TARGET VIEW: ${targetView === "auto" ? "Infer from the selected model reference and user brief; if ambiguous, use Image 1 exactly." : targetView}
OUTPUT RATIO: ${ratio}

Return only the JSON object required by the supplied output schema.`;
}

export function promptSchema() {
  const string = { type: "string" } as const;
  return { type: "object", additionalProperties: false, properties: { task: string, target_view: string, primary_base: string, reference_roles: { type: "array", items: string }, identity_anatomy_lock: string, pose_camera_lock: string, environment_lock: string, full_look_transfer: string, top_transfer: string, bottom_transfer: string, footwear_transfer: string, socks_transfer: string, accessories_transfer: string, fit_material_realism: string, preserve: { type: "array", items: string }, exclude: { type: "array", items: string } }, required: ["task","target_view","primary_base","reference_roles","identity_anatomy_lock","pose_camera_lock","environment_lock","full_look_transfer","top_transfer","bottom_transfer","footwear_transfer","socks_transfer","accessories_transfer","fit_material_realism","preserve","exclude"] } as const;
}

export function referenceGuard(images: readonly { category: string }[]) {
  const has = (label: string) => images.some((item) => item.category.includes(label));
  const fullLook = has("전신 착장"); const dedicatedTop = has("상의 디테일"); const dedicatedBottom = has("하의 디테일"); const top = fullLook || dedicatedTop; const bottom = fullLook || dedicatedBottom; const shoes = has("신발"); const socks = has("양말"); const accessories = has("액세서리/착용법");
  const authorized: string[] = []; const preserve: string[] = [];
  if (top) authorized.push("upper garment only"); else preserve.push("original base upper garment");
  if (bottom) authorized.push("lower garment only"); else preserve.push("original base lower garment");
  if (shoes) authorized.push("shoes only"); else preserve.push("original base shoes exactly");
  if (socks) authorized.push("socks only"); else preserve.push("original base socks or bare-ankle state exactly");
  if (accessories) authorized.push("explicitly referenced accessories only"); else preserve.push("original base accessory state; add no hat, bag, jewelry, eyewear, or other accessory");
  return { fullLook, dedicatedTop, dedicatedBottom, top, bottom, shoes, socks, accessories, authorized: `${authorized.join("; ") || "no wardrobe or wearable replacement"}. Do not transfer any other visible item from reference images.`, preserve: `${preserve.join("; ")}. Missing reference categories are immutable and may not be restyled, removed, or invented.` };
}

export function compilePrompt(s: Record<string, unknown>, ratio: string, images: readonly { category: string }[]): string {
  const guard = referenceGuard(images);
  const sourceImages = (label: string) => images.flatMap((item, index) => item.category.includes(label) ? [`Image ${index + 1}`] : []);
  const sourceAssignment = images.map((item, index) => `Image ${index + 1} = ${item.category}`).join("; ");
  const modelSources = sourceImages("모델").join(", ");
  const fullLookSources = sourceImages("전신 착장").join(", ");
  const topSources = sourceImages("상의 디테일").join(", ");
  const bottomSources = sourceImages("하의 디테일").join(", ");
  const shoesSources = sourceImages("신발").join(", ");
  const socksSources = sourceImages("양말").join(", ");
  const accessorySources = sourceImages("액세서리/착용법").join(", ");
  const fullLookTransfer = guard.fullLook
    ? `Analyzed outfit details: ${String(s.full_look_transfer ?? "").trim() || "derive every visible upper and lower garment directly from the source image"}. MANDATORY: Use ${fullLookSources} as the FULL LOOK wardrobe target and replace both original base garments with that visible outfit. The original base top and bottom are mutable source placeholders and must not remain.`
    : "";
  const topTransfer = guard.dedicatedTop
    ? `Analyzed top details: ${String(s.top_transfer ?? "").trim() || "derive the exact visible top product directly from the source image"}. MANDATORY: Replace the original base upper garment with the TOP product shown in ${topSources}. Its product color, construction, fabric, fit, seams, graphics, and logo placement override FULL LOOK.`
    : guard.fullLook
      ? `No dedicated TOP reference is supplied. Derive the upper garment completely from ${fullLookSources} and replace the original base upper garment; do not preserve, retain, or restyle the original top.`
      : "";
  const bottomTransfer = guard.dedicatedBottom
    ? `Analyzed bottom details: ${String(s.bottom_transfer ?? "").trim() || "derive the exact visible bottom product directly from the source image"}. MANDATORY: Replace the original base lower garment with the BOTTOM product shown in ${bottomSources}. Its product color, construction, fabric, fit, rise, length, pockets, graphics, and logo placement override FULL LOOK.`
    : guard.fullLook
      ? `No dedicated BOTTOM reference is supplied. Derive the lower garment completely from ${fullLookSources} and replace the original base lower garment; do not preserve, retain, or restyle the original bottom.`
      : "";
  const footwearTransfer = guard.shoes
    ? `Analyzed footwear details: ${String(s.footwear_transfer ?? "").trim() || "derive the exact shoes directly from the source image"}. Replace only the original shoes with the shoes shown in ${shoesSources}.`
    : "";
  const socksTransfer = guard.socks
    ? `Analyzed sock details: ${String(s.socks_transfer ?? "").trim() || "derive the exact socks directly from the source image"}. Replace only the original socks or bare-ankle state with the socks shown in ${socksSources}.`
    : "";
  const accessoriesTransfer = guard.accessories
    ? `Analyzed accessory details: ${String(s.accessories_transfer ?? "").trim() || "derive the exact accessory and wearing method directly from the source images"}. Apply only the accessories shown in ${accessorySources}.`
    : "";
  const replacementPriority = guard.fullLook
    ? "FULL LOOK mandates complete upper-and-lower wardrobe replacement. Dedicated TOP and BOTTOM references override their corresponding product details. The base MODEL controls no clothing where a wardrobe role is authorized."
    : "Each supplied dedicated TOP or BOTTOM reference mandates replacement of its corresponding base garment. Preserve only garment roles with no supplied reference.";
  const parts: Array<[string, unknown]> = [
    ["TASK", "Edit the base MODEL photograph by replacing every authorized wardrobe and wearable region. This is a product-transfer task, not a request to preserve the original outfit."],
    ["TARGET VIEW", s.target_view],
    ["PRIMARY MODEL — IMMUTABLE NON-CLOTHING ONLY", `${modelSources} controls only the same person, face, hair, skin, anatomy, body proportions, pose, gaze, camera, crop, background, lighting, shadows, subject scale, and placement. Its clothing and wearables are not immutable when their roles are authorized below.`],
    ["DETERMINISTIC SOURCE IMAGE ASSIGNMENT", sourceAssignment],
    ["WARDROBE REPLACEMENT PRIORITY", replacementPriority],
    ["IDENTITY & ANATOMY LOCK", "Preserve the exact MODEL person, face, hair, skin, expression, anatomy, body proportions, hands, fingers, legs, and feet. Do not preserve the original garments over authorized replacement regions."],
    ["POSE, CAMERA & FRAMING LOCK", "Preserve the exact MODEL pose, limb positions, gaze, viewpoint, perspective, crop, subject size, and placement."],
    ["BACKGROUND, LIGHTING & SHADOW LOCK", "Preserve the exact MODEL background, lighting direction, exposure, color, floor contact, and cast shadows; adapt only new product materials and contact shadows to that unchanged scene."],
    ["FULL-LOOK MANDATORY TRANSFER", fullLookTransfer],
    ["TOP PRODUCT TRANSFER", topTransfer],
    ["BOTTOM PRODUCT TRANSFER", bottomTransfer],
    ["FOOTWEAR TRANSFER", footwearTransfer],
    ["SOCKS TRANSFER", socksTransfer],
    ["ACCESSORY TRANSFER", accessoriesTransfer],
    ["AUTHORIZED REPLACEMENTS", guard.authorized],
    ["UNREFERENCED ITEMS — PRESERVE FROM BASE", guard.preserve],
    ["PHYSICAL FIT & MATERIAL REALISM", `${String(s.fit_material_realism ?? "").trim()} Render physically accurate garment construction, fabric drape, folds, tension, contact points, occlusion, perspective, and shadows on the unchanged MODEL body and pose.`.trim()],
    ["PRESERVE EXACTLY", "MODEL identity, face, hair, skin, anatomy, body proportions, pose, camera, crop, background, lighting, and shadows only; plus only wearable roles explicitly listed as unreferenced above."],
    ["DO NOT ADD, CHANGE, OR IMPORT", "Do not import any reference person, body, pose, camera, crop, background, lighting, or unrelated item. Do not preserve any original base garment or wearable whose role is authorized for replacement. No extra people, duplicated products, text, watermark, interface, collage, or split image."],
    ["FINAL OUTPUT", `One centered subject only. ${ratio} aspect ratio. One continuous undivided photorealistic image. The result must be the MODEL photograph with every authorized product visibly replaced and no authorized original garment remaining. Product replacement has absolute priority over clothing preservation; only non-clothing MODEL attributes and explicitly unreferenced wearable roles remain unchanged.`],
  ];
  return parts.filter(([,value])=>String(value??"").trim()).map(([key,value])=>`${key}: ${String(value).trim()}`).join("\n");
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const direct = (payload as { output_text?: unknown }).output_text; if (typeof direct === "string") return direct;
  const output = (payload as { output?: unknown }).output; if (!Array.isArray(output)) return "";
  for (const item of output) { if (!item || typeof item !== "object" || !Array.isArray((item as {content?:unknown}).content)) continue; for (const part of (item as {content:unknown[]}).content) if (part && typeof part === "object" && typeof (part as {text?:unknown}).text === "string") return (part as {text:string}).text; }
  return "";
}

export async function composeHorizonPrompt(input: { brief: string; ratio: string; targetView: string; images: HorizonPromptImage[]; fetchImpl?: typeof fetch; apiKey?: string; timeoutMs?: number }) {
  const apiKey = input.apiKey ?? bindings().OPENAI_API_KEY;
  if (!apiKey) return { ok: false as const, code: "missing_openai_api_key", message: "회사 OpenAI 서버 설정을 확인해 주세요." };
  const brief = input.brief.trim() || "AUTO MODE: infer the intended wardrobe and wearable transfer exclusively from the selected labeled reference categories. Replace every supplied dedicated product role and preserve every missing role from the immutable model base.";
  const promptImages = await prepareHorizonPromptImages(input.images);
  const response = await postOpenAiJson({ apiKey, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs ?? HORIZON_OPENAI_TIMEOUT_MS, body: { model: "gpt-5.6-terra", input: [{ role: "user", content: [{ type: "input_text", text: buildCodexPrompt(brief,input.ratio,input.targetView,input.images) }, ...promptImages.map((image)=>({ type:"input_image" as const, image_url:imageDataUrl(image.bytes,image.contentType), detail:"high" as const }))] }], text: { format: { type: "json_schema", name: "horizon_fashion_prompt", strict: true, schema: promptSchema() } } } });
  if (!response.ok) {
    if (response.failure === "timeout") return { ok: false as const, code: "openai_timeout", message: "GPT 이미지 분석 시간이 초과됐습니다. 같은 작업을 다시 시도해 주세요." };
    return { ok: false as const, code: "openai_error", message: "GPT 명령어 작성 요청에 실패했습니다." };
  }
  try { const spec = JSON.parse(extractOutputText(response.payload)) as Record<string,unknown>; return { ok:true as const, prompt:compilePrompt(spec,input.ratio,input.images), spec, model:"gpt-5.6-terra", promptVersion:HORIZON_PROMPT_VERSION }; } catch { return { ok:false as const, code:"invalid_profile", message:"GPT가 올바른 JSON을 반환하지 않았습니다." }; }
}
