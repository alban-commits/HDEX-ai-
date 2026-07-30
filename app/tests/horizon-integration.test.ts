import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createJobClient } from "@higgsfield/fnf/client";
import { nanoBanana2 } from "@higgsfield/fnf/jobs";
import { HORIZON_PROMPT_MAX_DECLARED_BYTES, HORIZON_PROMPT_MAX_TOTAL_BYTES, handleHorizonPrompt } from "../src/server/horizon-prompt-route.server";
import { HORIZON_MAX_FOLDER_DEPTH, HORIZON_MAX_FOLDER_FILES, HORIZON_SLOTS, claimHorizonImageReservation, horizonBatchProgress, horizonConnectionState, horizonGenerationMatchesEngine, renumberHorizonImages, resolveHorizonBatchOutcome, scanHorizonFolder, selectHorizonImages } from "../src/lib/horizon";
import { runHorizonGenerationFlow, uploadHorizonAssets, withHorizonUploadedAssets } from "../src/lib/horizon.browser";
import { disconnectHiggsfieldOAuth } from "../src/lib/fnf.browser";
import { buildCodexPrompt, compilePrompt, HORIZON_PROMPT_VERSION, promptSchema, referenceGuard } from "../src/server/horizon-prompt.server";
import { clearHiggsfieldRuntime, getHiggsfieldCapabilityRecord, inspectHiggsfieldCapabilities, inspectHiggsfieldProvider } from "../src/server/higgsfield-mcp.server";
import { clearGenerationRuntime, createHiggsfieldGeneration, getHiggsfieldGeneration, listHiggsfieldGenerations } from "../src/server/higgsfield-generation-adapter.server";
import { uploadHiggsfieldImage } from "../src/server/higgsfield-media.server";
import { normalizeHiggsfieldUploadImage } from "../src/server/image-validation.server";
import { higgsfieldOAuthSessionFingerprint, type HiggsfieldOAuthSession } from "../src/server/higgsfield-oauth.server";
import { getGenerationJob, hasGenerationMedia, putGenerationJobs, registerGenerationMedia } from "../src/server/generation-attempt-store.server";

const NOW = Date.UTC(2099, 1, 1);
const root = await mkdtemp(join(tmpdir(), "hdex-horizon-test-"));
const env = { HDEX_GENERATION_ENABLED: "true", HDEX_TEMP_DIR: root, HDEX_TEMP_TTL_SECONDS: "3600" } as NodeJS.ProcessEnv;
afterAll(async () => rm(root, { recursive: true, force: true }));

function file(name: string, path: string): File {
  const value = new File(["x"], name, { type: "image/png" });
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}

describe("Horizon selection and folder contracts", () => {
  test("does not show a connected or disconnected state while OAuth scope is loading", () => {
    expect(horizonConnectionState(undefined)).toEqual({ status: "loading", label: "Higgsfield 연결 확인 중" });
    expect(horizonConnectionState("guest").status).toBe("disconnected");
    expect(horizonConnectionState("higgsfield-oauth:personal").status).toBe("connected");
  });
  test("keeps nine roles, M/W/A numbering, explicit-code and direction selection", () => {
    expect(HORIZON_SLOTS).toHaveLength(9);
    const numbered = renumberHorizonImages([
      { id:"m1",slotId:"model-front",category:"",selected:true,name:"m1" },
      { id:"m2",slotId:"model-side",category:"",selected:true,name:"m2" },
      { id:"w1",slotId:"full-look",category:"",selected:true,name:"w1" },
      { id:"w2",slotId:"top",category:"",selected:true,name:"w2" },
      { id:"a1",slotId:"shoes",category:"",selected:true,name:"a1" },
    ]);
    expect(numbered.map((item)=>item.code)).toEqual(["M1","M2","W1","W2","A1"]);
    expect(selectHorizonImages(numbered,"W2 A1","side").map((item)=>item.code)).toEqual(["M2","W2","A1"]);
    expect(selectHorizonImages(numbered,"M1 W1","auto").map((item)=>item.code)).toEqual(["M1","W1"]);
  });

  test("scans nested browser folder paths using the 1-8 role map", () => {
    const jobs = scanHorizonFolder([
      file("1.png","root/look-a/1.png"), file("3-top.png","root/look-a/3-top.png"),
      file("7.png","root/look-a/7.png"), file("2.png","root/look-b/2.png"),
    ]);
    expect(jobs.map((job)=>({name:job.name,ready:job.ready,numbers:job.files.map((item)=>item.number)}))).toEqual([
      { name:"root/look-a",ready:true,numbers:[1,3,7] },
      { name:"root/look-b",ready:false,numbers:[2] },
    ]);
  });

  test("keeps duplicate numbered roles unique and rejects a folder with 15 applicable images", () => {
    const fourteen = [file("1.png", "root/look/1.png")];
    for (let index = 0; index < 13; index += 1) {
      fourteen.push(file(`3-${index + 1}.png`, `root/look/3-${index + 1}.png`));
    }
    const accepted = scanHorizonFolder(fourteen)[0]!;
    expect(accepted.ready).toBe(true);
    expect(accepted.files.map((item) => item.category.split(" · ")[0])).toEqual([
      "M1", "W2", "W2-2", "W2-3", "W2-4", "W2-5", "W2-6", "W2-7",
      "W2-8", "W2-9", "W2-10", "W2-11", "W2-12", "W2-13",
    ]);
    const rejected = scanHorizonFolder([
      ...fourteen,
      file("4.png", "root/look/4.png"),
    ])[0]!;
    expect(rejected).toMatchObject({ ready: false, error: "too_many_images" });
    expect(rejected.files).toHaveLength(15);
  });

  test("bounds folder scanning by file count and path depth", () => {
    const files = Array.from({ length: HORIZON_MAX_FOLDER_FILES + 1 }, (_, index) =>
      file(`${index === 0 ? 1 : 2}-${index}.png`, `root/look-${index}/${index === 0 ? 1 : 2}-${index}.png`));
    const jobs = scanHorizonFolder(files);
    expect(jobs).toHaveLength(HORIZON_MAX_FOLDER_FILES);
    const deep = `${Array.from({ length: HORIZON_MAX_FOLDER_DEPTH + 1 }, () => "nested").join("/")}/1.png`;
    expect(scanHorizonFolder([file("1.png", deep)])).toEqual([]);
  });

  test("reserves concurrent selections atomically before upload starts", () => {
    let reserved = 0;
    reserved = claimHorizonImageReservation(0, reserved, 8)!;
    expect(reserved).toBe(8);
    expect(claimHorizonImageReservation(0, reserved, 8)).toBeNull();
    reserved -= 8;
    expect(claimHorizonImageReservation(0, reserved, 8)).toBe(8);
  });

  test("counts missing and failed batch results against the requested quantity", () => {
    const generations = [
      { id: "ready", status: "completed", input: { model: "gpt_image_2", settings: { resolution: "2k" } }, results: { rawUrl: "https://cdn.example/ready.png" } },
      { id: "failed", status: "failed", input: { model: "gpt_image_2", settings: { resolution: "2k" } } },
      { id: "wrong-model", status: "completed", input: { model: "nano_banana_2", settings: { resolution: "2k" } }, results: { rawUrl: "https://cdn.example/wrong.png" } },
    ] as never;
    const outcome = resolveHorizonBatchOutcome(generations, "gpt-2k", "Look / A", 4);
    expect(outcome).toMatchObject({ successCount: 1, failureCount: 3 });
    expect(outcome.results).toEqual([{ url: "https://cdn.example/ready.png", filename: "Look-A-01-2k.png" }]);
    expect(horizonBatchProgress([
      { ready: true, status: "completed" },
      { ready: true, status: "failed" },
      { ready: false, status: "queued" },
    ])).toEqual({ processed: 2, total: 2, percent: 100 });
  });

  test("switches recent results immediately by the selected engine and resolution", () => {
    const generations = [
      { id: "gpt-2k", input: { model: "gpt_image_2", settings: { resolution: "2k" } } },
      { id: "gpt-4k", input: { model: "gpt_image_2", settings: { resolution: "4k" } } },
      { id: "nano-2k", input: { model: "nano_banana_2", settings: { resolution: "2k" } } },
      { id: "nano-4k", input: { model: "nano_banana_2", settings: { resolution: "4K" } } },
      { id: "soul", input: { model: "text2image_soul_v2", settings: { resolution: "2k" } } },
    ];
    const visible = (engine: "gpt-2k" | "nano-2k" | "nano-4k") => generations
      .filter((generation) => horizonGenerationMatchesEngine(generation, engine))
      .map((generation) => generation.id);
    expect(visible("gpt-2k")).toEqual(["gpt-2k"]);
    expect(visible("nano-2k")).toEqual(["nano-2k"]);
    expect(visible("nano-4k")).toEqual(["nano-4k"]);
  });
});

describe("Horizon browser mutation boundaries", () => {
  test("uses DELETE and accepts only the exact successful disconnect envelope", async () => {
    const originalFetch = globalThis.fetch;
    let responseBody: unknown = { connected: false, transport: "mcp_oauth" };
    globalThis.fetch = async (path, init) => {
      expect(path).toBe("/api/higgsfield/oauth/disconnect");
      expect(init?.method).toBe("DELETE");
      expect(init?.credentials).toBe("include");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return Response.json(responseBody, {
        status: 200,
        headers: { "X-HDEX-API-Response": "1" },
      });
    };
    try {
      await expect(disconnectHiggsfieldOAuth()).resolves.toBeUndefined();
      responseBody = { connected: true, transport: "mcp_oauth" };
      await expect(disconnectHiggsfieldOAuth()).rejects.toMatchObject({
        code: "adapter_response_contract_invalid",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rolls back partial uploads and releases every batch upload after a later failure", async () => {
    const files = [file("one.png", "one.png"), file("two.png", "two.png")];
    const released: string[] = [];
    let uploadIndex = 0;
    await expect(
      uploadHorizonAssets(files, {
        upload: async (entry) => {
          uploadIndex += 1;
          if (uploadIndex === 2) throw new Error("upload_failed");
          return { name: entry.name, type: entry.type, src: "blob:preview", ref: { id: "partial-upload", type: "media_input" } };
        },
        release: (mediaId) => released.push(mediaId),
      }),
    ).rejects.toThrow("upload_failed");
    expect(released).toEqual(["partial-upload"]);

    released.length = 0;
    await expect(
      withHorizonUploadedAssets(
        files,
        async () => { throw new Error("prompt_or_submit_failed"); },
        {
          upload: async (entry) => ({ name: entry.name, type: entry.type, src: "blob:preview", ref: { id: `batch-${entry.name}`, type: "media_input" } }),
          release: (mediaId) => released.push(mediaId),
        },
      ),
    ).rejects.toThrow("prompt_or_submit_failed");
    expect(released).toEqual(["batch-one.png", "batch-two.png"]);
  });

  test("writes an empty command once and generates once in the same explicit action", async () => {
    let promptCalls = 0;
    let generationCalls = 0;
    const result = await runHorizonGenerationFlow({
      command: "",
      writePrompt: async () => { promptCalls += 1; return "compiled prompt"; },
      generate: async (command) => { generationCalls += 1; return command; },
    });
    expect(result).toBe("compiled prompt");
    expect({ promptCalls, generationCalls }).toEqual({ promptCalls: 1, generationCalls: 1 });
  });
});

describe("Horizon prompt contract", () => {
  test("preserves the V5 schema, hierarchy, and golden compiled sections", () => {
    expect(HORIZON_PROMPT_VERSION).toBe("fashion-auto-numbering-angle-lock-v5-terra");
    expect(promptSchema().required).toHaveLength(16);
    const images = [{category:"M1 · 모델 정면"},{category:"W1 · 전신 착장"},{category:"A1 · 신발"}];
    const guard = referenceGuard(images);
    expect(guard).toMatchObject({fullLook:true,top:true,bottom:true,shoes:true,socks:false,accessories:false});
    const prompt = compilePrompt({ task:"Transfer",target_view:"front",primary_base:"Image 1",reference_roles:["Image 1 base"],identity_anatomy_lock:"Lock identity",pose_camera_lock:"Lock camera",environment_lock:"Lock environment",full_look_transfer:"Transfer look",top_transfer:"Top",bottom_transfer:"Bottom",footwear_transfer:"Shoes",socks_transfer:"",accessories_transfer:"",fit_material_realism:"Natural fit",preserve:["face"],exclude:["text"] },"2:3",images);
    expect(prompt).toContain("PRIMARY IMMUTABLE BASE: Image 1");
    expect(prompt).toContain("AUTHORIZED REPLACEMENTS: upper garment only; lower garment only; shoes only");
    expect(prompt).toContain("original base socks or bare-ankle state exactly");
    expect(prompt).toContain("FINAL OUTPUT: One centered subject only. 2:3 aspect ratio.");
    expect(buildCodexPrompt("M1 W1 A1","2:3","front",images)).toContain("USER BRIEF: M1 W1 A1");
  });

  test("rejects declared and actual bodies above 80 MiB before OpenAI", async () => {
    let composeCalls = 0;
    const requireSession = async () => ({
      config: { publicOrigin: "https://hdex-ai.company.example" },
      session: {},
      rotatedCookies: null,
    } as never);
    const declared = await handleHorizonPrompt(new Request("https://hdex-ai.company.example/api/openai/horizon", {
      method: "POST",
      headers: { "content-length": String(HORIZON_PROMPT_MAX_DECLARED_BYTES + 1) },
      body: "x",
    }), { requireSession, composePrompt: async () => { composeCalls += 1; throw new Error("must_not_run"); } });
    expect(declared.status).toBe(413);
    expect(declared.headers.get("cache-control")).toBe("no-store");

    const form = new FormData();
    form.append("image", new File([new Uint8Array(2)], "one.png", { type: "image/png" }));
    form.append("image", new File([new Uint8Array(2)], "two.png", { type: "image/png" }));
    form.set("data", JSON.stringify({ brief: "", ratio: "2:3", targetView: "auto", categories: ["M1", "W1"] }));
    const actual = await handleHorizonPrompt(new Request("https://hdex-ai.company.example/api/openai/horizon", { method: "POST", body: form }), {
      requireSession,
      composePrompt: async () => { composeCalls += 1; throw new Error("must_not_run"); },
      maxTotalBytes: 3,
      parseFormData: async () => form,
    });
    expect(actual.status).toBe(413);
    expect(await actual.json()).toMatchObject({ ok: false, code: "payload_too_large" });
    expect(composeCalls).toBe(0);
    expect(HORIZON_PROMPT_MAX_TOTAL_BYTES).toBe(80 * 1024 * 1024);
  });

  test("returns a safe 502 for an OpenAI provider failure", async () => {
    const image = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).png().toBuffer());
    const form = new FormData();
    form.append("image", new File([image], "model.png", { type: "image/png" }));
    form.set("data", JSON.stringify({ brief: "", ratio: "2:3", targetView: "auto", categories: ["M1"] }));
    const response = await handleHorizonPrompt(new Request("https://hdex-ai.company.example/api/openai/horizon", { method: "POST", body: form }), {
      requireSession: async () => ({ config: { publicOrigin: "https://hdex-ai.company.example" }, session: {}, rotatedCookies: null } as never),
      composePrompt: async () => { throw new Error("private_provider_detail"); },
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, code: "provider_error", message: "GPT 명령어 작성 요청에 실패했습니다." });
  });
});

const toolList = [
  {
    name: "models_explore",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["search", "get", "list"] } },
    },
  },
  {
    name: "media_upload",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { filename: { type: "string" }, content_type: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "media_confirm",
    inputSchema: {
      type: "object",
      properties: {
        media_ids: { type: "array", items: { type: "string" } },
        type: { type: "string" },
      },
    },
  },
  {
    name: "generate_image",
    inputSchema: {
      type: "object",
      properties: {
        params: {
          type: "object",
          properties: {
            aspect_ratio: { type: "string" },
            medias: {
              type: "array",
              maxItems: 14,
              items: {
                type: "object",
                required: ["role", "value"],
                properties: { role: { type: "string" }, value: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "job_status",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } } },
  },
];
const aspects = ["2:3","3:2","3:4","4:3","9:16","16:9","1:1"];
function model(id:string) {
  if(id==="nano_banana_pro") return {id,name:"Google Nano Banana Pro",provider_name:"Google",output_type:"image",aspect_ratios:aspects,parameters:[{name:"aspect_ratio",options:aspects},{name:"resolution",options:["2k","4k"]}],medias:[{roles:["reference"],max:14}]};
  if(id==="soul_v2") return {id,name:"Higgsfield Soul V2",provider_name:"Higgsfield",output_type:"image",aspect_ratios:aspects.filter((v)=>v!=="3:2"),parameters:[{name:"aspect_ratio",options:aspects.filter((v)=>v!=="3:2")},{name:"quality",options:["1.5k","2k"]}],medias:[{roles:["reference"],max:1}]};
  return {id,name:"GPT Image 2",provider_name:"OpenAI",output_type:"image",aspect_ratios:aspects,parameters:[{name:"aspect_ratio",options:aspects},{name:"resolution",options:["2k"]},{name:"quality",options:["high"]}],medias:[{roles:["reference"],max:14}]};
}
const session:HiggsfieldOAuthSession={schemaVersion:"hdex.higgsfield-oauth-session.v1",accessToken:"same-provider-account",refreshToken:"same-refresh",clientId:"browser-a",tokenEndpoint:"https://auth.higgsfield.ai/token",resource:"https://mcp.higgsfield.ai/mcp",accessExpiresAt:NOW+3600000,sessionExpiresAt:NOW+86400000};

describe("Nano Banana Pro MCP boundary", () => {
  test("discovers validated 2k/4k profile without generation or upload calls", async () => {
    const calls:string[]=[];
    const record=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(name,args)=>{calls.push(name);return {structuredContent:model(String(args.model_id))};}});
    expect(record.models.map((item)=>({key:item.key,ready:item.available}))).toEqual([{key:"soul_2",ready:true},{key:"gpt_image_2",ready:true},{key:"nano_banana_pro",ready:true}]);
    expect(record.models[2]).toMatchObject({modelId:"nano_banana_pro",maximumImages:14,resolutionValues:{"2k":"2k","4k":"4k"}});
    expect(new Set(calls)).toEqual(new Set(["models_explore"]));
  });

  test("fails GPT and Nano profiles closed when generate_image accepts fewer than 14 images", async () => {
    const limitedTools = structuredClone(toolList);
    const generate = limitedTools.find((tool) => tool.name === "generate_image")!;
    const params = generate.inputSchema.properties.params as { properties: { medias: { maxItems: number } } };
    params.properties.medias.maxItems = 13;
    const record = await inspectHiggsfieldProvider({ includeNano: true, now: NOW, listTools: async () => ({ tools: limitedTools }), callTool: async (_name,args)=>({structuredContent:model(String(args.model_id))}) });
    expect(record.models.find((item) => item.key === "soul_2")).toMatchObject({ available: true, maximumImages: 1 });
    expect(record.models.find((item) => item.key === "gpt_image_2")).toMatchObject({ available: false, reason: "profile_invalid" });
    expect(record.models.find((item) => item.key === "nano_banana_pro")).toMatchObject({ available: false, reason: "profile_invalid" });
  });

  test("maps public nano_banana_2 to provider nano_banana_pro once", async () => {
    const record=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    const fingerprint=higgsfieldOAuthSessionFingerprint(session);
    await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:session.resource,accessToken:session.accessToken,now:NOW,runner:async()=>record});
    await registerGenerationMedia({sessionFingerprint:fingerprint,mediaId:"media-a",env,now:NOW});
    const calls:Array<{name:string;args:Record<string,unknown>}>=[];
    const jobs=await createHiggsfieldGeneration({fingerprint,session,jobSetType:"nano_banana_2",params:{prompt:"safe prompt",aspect_ratio:"2:3",resolution:"4k",batch_size:1,input_images:[{id:"media-a",type:"media_input"}]},confirmationToken:"request-identifier-0001",env,now:NOW,callTool:async(name,args)=>{calls.push({name,args});return {structuredContent:{results:[{id:"nano-job-1",model:"nano_banana_pro",status:"queued"}]}};}});
    expect(jobs[0]).toMatchObject({job_set_type:"nano_banana_2"});
    expect(calls).toHaveLength(1); expect(calls[0]?.name).toBe("generate_image");
    expect(calls[0]?.args).toMatchObject({params:{model:"nano_banana_pro",resolution:"4k",medias:[{role:"reference",value:"media-a"}]}});
    await clearGenerationRuntime(fingerprint,env);
  });

  test("round-trips Nano input_images and resolution through create/get/list clients", async () => {
    const fingerprint = higgsfieldOAuthSessionFingerprint({ ...session, browserSessionId: "n".repeat(43) });
    const activeSession = { ...session, browserSessionId: "n".repeat(43) };
    const record=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:activeSession.resource,accessToken:activeSession.accessToken,now:NOW,runner:async()=>record});
    await registerGenerationMedia({ sessionFingerprint: fingerprint, mediaId: "nano-roundtrip-media", env, now: NOW });
    let storedParams: Record<string, unknown> | undefined;
    const client = createJobClient({
      jobs: [nanoBanana2] as const,
      adapter: {
        confirm: async () => "nano-roundtrip-request",
        createJobs: async (request) => {
          const jobs = await createHiggsfieldGeneration({
            fingerprint,
            session: activeSession,
            jobSetType: request.jobSetType as "nano_banana_2",
            params: request.params,
            confirmationToken: request.confirmationToken!,
            env,
            now: NOW,
            callTool: async () => ({ structuredContent: { results: [{ id: "nano-roundtrip-job", model: "nano_banana_pro", status: "completed", results: { rawUrl: "https://cdn.higgsfield.ai/nano-roundtrip.png" } }] } }),
          });
          storedParams = jobs[0]?.params;
          return jobs;
        },
        getJob: (id) => getHiggsfieldGeneration({ fingerprint, session: activeSession, jobId: id, env, now: NOW }),
        listJobs: (query) => listHiggsfieldGenerations({ fingerprint, size: query.size, env, now: NOW }),
        estimateCost: async () => ({ credits: 0 }),
      },
    });
    const submitted = await client.submit({
      model: "nano_banana_2",
      prompt: { instruction: "safe prompt" },
      media: { image: [{ id: "nano-roundtrip-media", type: "media_input" }] },
      settings: { aspectRatio: "2:3", resolution: "4k", batchSize: 1 },
    });
    expect(storedParams).toMatchObject({ input_images: [{ id: "nano-roundtrip-media", type: "media_input" }], resolution: "4k" });
    expect(storedParams).not.toHaveProperty("medias");
    for (const generation of [submitted.generations[0]!, await client.get("nano-roundtrip-job"), (await client.list({ model: "nano_banana_2" })).items[0]!]) {
      expect(generation.input).toMatchObject({
        model: "nano_banana_2",
        media: { image: [{ id: "nano-roundtrip-media", type: "media_input" }] },
        settings: { resolution: "4k" },
      });
    }
    clearHiggsfieldRuntime(fingerprint);
    await clearGenerationRuntime(fingerprint, env);
  });

  test("allows 14 GPT/Nano references and blocks 15 before generate_image", async () => {
    const record=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    for (const target of [
      { jobSetType: "gpt_image_2" as const, providerModel: "gpt_image_2", extra: { quality: "high" }, field: "medias" },
      { jobSetType: "nano_banana_2" as const, providerModel: "nano_banana_pro", extra: {}, field: "input_images" },
    ]) {
      const activeSession = { ...session, browserSessionId: (target.jobSetType === "gpt_image_2" ? "g" : "b").repeat(43) };
      const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession);
      await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:activeSession.resource,accessToken:activeSession.accessToken,now:NOW,runner:async()=>record});
      const refs = Array.from({ length: 15 }, (_, index) => ({ id: `${target.jobSetType}-${index}`, type: "media_input" }));
      for (const ref of refs) await registerGenerationMedia({ sessionFingerprint: fingerprint, mediaId: ref.id, env, now: NOW });
      let generateCalls = 0;
      let providerParams: Record<string, unknown> | undefined;
      const callTool = async (_name: "generate_image" | "job_status", args: Record<string, unknown>) => {
        generateCalls += 1;
        providerParams = args.params as Record<string, unknown>;
        return { structuredContent: { results: [{ id: `${target.jobSetType}-job`, model: target.providerModel, status: "queued" }] } };
      };
      const base = { prompt: "safe prompt", aspect_ratio: target.jobSetType === "gpt_image_2" ? "3:2" : "2:3", resolution: "2k", batch_size: 1, ...target.extra };
      await expect(createHiggsfieldGeneration({
        fingerprint,
        session: activeSession,
        jobSetType: target.jobSetType,
        params: { ...base, [target.field]: refs.slice(0, 14) },
        confirmationToken: `${target.jobSetType}-fourteen-request`,
        env,
        now: NOW,
        callTool,
      })).resolves.toHaveLength(1);
      await expect(createHiggsfieldGeneration({
        fingerprint,
        session: activeSession,
        jobSetType: target.jobSetType,
        params: { ...base, [target.field]: refs },
        confirmationToken: `${target.jobSetType}-fifteen-request`,
        env,
        now: NOW,
        callTool,
      })).rejects.toMatchObject({ code: "model_contract_mismatch" });
      expect(generateCalls).toBe(1);
      if (target.jobSetType === "gpt_image_2") expect(providerParams).toMatchObject({ aspect_ratio: "3:2" });
      clearHiggsfieldRuntime(fingerprint);
      await clearGenerationRuntime(fingerprint, env);
    }
  });
});

describe("same provider account browser-session isolation", () => {
  test("isolates uploads, jobs, capabilities, and disconnect cleanup by browser fingerprint", async () => {
    const common={schemaVersion:"hdex.higgsfield-oauth-session.v1" as const,accessToken:"same-account-token",refreshToken:"same-account-refresh",tokenEndpoint:"https://auth.higgsfield.ai/token",resource:"https://mcp.higgsfield.ai/mcp",accessExpiresAt:NOW+3600000,sessionExpiresAt:NOW+86400000};
    const a=higgsfieldOAuthSessionFingerprint({...common,clientId:"same-provider-client",browserSessionId:"a".repeat(43)}); const b=higgsfieldOAuthSessionFingerprint({...common,clientId:"same-provider-client",browserSessionId:"b".repeat(43)});
    expect(a).not.toBe(b);
    await registerGenerationMedia({sessionFingerprint:a,mediaId:"upload-a",env,now:NOW}); await registerGenerationMedia({sessionFingerprint:b,mediaId:"upload-b",env,now:NOW});
    await putGenerationJobs({sessionFingerprint:a,env,now:NOW,jobs:[{id:"job-a",providerJobId:"job-a",providerModelId:"nano_banana_pro",jobSetType:"nano_banana_2",status:"queued",createdAt:NOW,expiresAt:NOW+3600000,params:{}}]});
    await putGenerationJobs({sessionFingerprint:b,env,now:NOW,jobs:[{id:"job-b",providerJobId:"job-b",providerModelId:"nano_banana_pro",jobSetType:"nano_banana_2",status:"queued",createdAt:NOW,expiresAt:NOW+3600000,params:{}}]});
    const capability=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    await inspectHiggsfieldCapabilities({sessionFingerprint:a,mcpUrl:common.resource,accessToken:common.accessToken,now:NOW,runner:async()=>capability});
    await inspectHiggsfieldCapabilities({sessionFingerprint:b,mcpUrl:common.resource,accessToken:common.accessToken,now:NOW,runner:async()=>capability});
    expect(await hasGenerationMedia({sessionFingerprint:a,mediaIds:["upload-a"],env,now:NOW})).toBe(true);
    expect(await hasGenerationMedia({sessionFingerprint:b,mediaIds:["upload-a"],env,now:NOW})).toBe(false);
    expect(await getGenerationJob({sessionFingerprint:a,jobId:"job-b",env,now:NOW})).toBeNull();
    expect(await getGenerationJob({sessionFingerprint:b,jobId:"job-b",env,now:NOW})).not.toBeNull();
    clearHiggsfieldRuntime(a);
    await clearGenerationRuntime(a,env);
    expect(await hasGenerationMedia({sessionFingerprint:a,mediaIds:["upload-a"],env,now:NOW})).toBe(false);
    expect(await hasGenerationMedia({sessionFingerprint:b,mediaIds:["upload-b"],env,now:NOW})).toBe(true);
    expect(await getGenerationJob({sessionFingerprint:a,jobId:"job-a",env,now:NOW})).toBeNull();
    expect(await getGenerationJob({sessionFingerprint:b,jobId:"job-b",env,now:NOW})).not.toBeNull();
    expect(getHiggsfieldCapabilityRecord(a,NOW)).toBeNull();
    expect(getHiggsfieldCapabilityRecord(b,NOW)).not.toBeNull();
    clearHiggsfieldRuntime(b);
    await clearGenerationRuntime(b,env);
  });
});

describe("Horizon WebP upload boundary", () => {
  test("normalizes decoded WebP to bounded PNG and uploads with Nano-only readiness", async () => {
    const webp = new Uint8Array(await sharp({ create: { width: 4, height: 3, channels: 4, background: "#00ff00" } }).webp().toBuffer());
    const normalized = await normalizeHiggsfieldUploadImage({ bytes: webp, contentType: "image/webp", maxOriginalBytes: 20 * 1024 * 1024 });
    expect(normalized).toMatchObject({ contentType: "image/png", extension: "png", normalized: true });
    expect(normalized.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const activeSession = { ...session, browserSessionId: "w".repeat(43) };
    const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession);
    const discovered=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    const nanoOnly = {
      ...discovered,
      models: discovered.models.map((profile) => profile.key === "nano_banana_pro"
        ? profile
        : { ...profile, available: false as const, reason: "profile_invalid" as const }),
    };
    await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:activeSession.resource,accessToken:activeSession.accessToken,now:NOW,runner:async()=>nanoOnly});
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ref = await uploadHiggsfieldImage({
      session: activeSession,
      fingerprint,
      filename: "normalized-image.png",
      contentType: normalized.contentType,
      bytes: normalized.bytes,
      env,
      now: NOW,
      callTool: async (name, args) => {
        calls.push({ name, args });
        return name === "media_upload"
          ? { uploads: [{ media_id: "normalized-media", upload_url: "https://uploads.higgsfield.ai/put", content_type: "image/png", method: "PUT" }] }
          : { results: [{ media_id: "normalized-media", status: "confirmed" }] };
      },
      uploadFetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
        expect((init?.body as Blob).type).toBe("image/png");
        return new Response(null, { status: 200 });
      },
    });
    expect(ref).toEqual({ id: "normalized-media", type: "image" });
    expect(calls[0]).toMatchObject({ name: "media_upload", args: { files: [{ filename: "normalized-image.png", content_type: "image/png" }] } });
    expect(calls.map((call) => call.name)).toEqual(["media_upload", "media_confirm"]);
    clearHiggsfieldRuntime(fingerprint);
    await clearGenerationRuntime(fingerprint, env);
  });

  test("rejects invalid WebP conversion and blocks upload when no approved model is ready", async () => {
    await expect(normalizeHiggsfieldUploadImage({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp", maxOriginalBytes: 20 * 1024 * 1024 })).rejects.toThrow();
    const activeSession = { ...session, browserSessionId: "z".repeat(43) };
    const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession);
    const discovered=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    const noneReady = { ...discovered, models: discovered.models.map((profile) => ({ ...profile, available: false as const, reason: "profile_invalid" as const })) };
    await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:activeSession.resource,accessToken:activeSession.accessToken,now:NOW,runner:async()=>noneReady});
    let calls = 0;
    await expect(uploadHiggsfieldImage({
      session: activeSession,
      fingerprint,
      filename: "normalized-image.png",
      contentType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      callTool: async () => { calls += 1; return {}; },
    })).rejects.toMatchObject({ reason: "capability_required" });
    expect(calls).toBe(0);
    clearHiggsfieldRuntime(fingerprint);
  });
});
