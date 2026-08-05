import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { initializeCanvas, readPsd } from "ag-psd";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { createJobClient, type Generation, type ListResult } from "@higgsfield/fnf/client";
import { nanoBanana2 } from "@higgsfield/fnf/jobs";
import { flattenFeedPages, fnfKeys, jobsFeedQueryOptions } from "@higgsfield/fnf-react";
import { HORIZON_PROMPT_MAX_DECLARED_BYTES, HORIZON_PROMPT_MAX_TOTAL_BYTES, handleHorizonPrompt } from "../src/server/horizon-prompt-route.server";
import { HORIZON_MAX_FOLDER_DEPTH, HORIZON_MAX_FOLDER_FILES, HORIZON_SLOTS, HorizonBatchStepError, claimHorizonImageReservation, horizonBatchFailureMessage, horizonBatchProgress, horizonBatchStageFailureMessage, horizonConnectionState, horizonGenerationMatchesEngine, renumberHorizonImages, resolveHorizonBatchOutcome, runHorizonBatchSequence, scanHorizonFolder, selectHorizonImages, settleHorizonBatchStatus } from "../src/lib/horizon";
import { HORIZON_COMPLETED_DIRECTORY_NAME, HorizonDirectoryScanError, horizonDirectoryPickerFor, pickHorizonBatchDirectory, requestHorizonBatchDirectoryPermission, restoreHorizonBatchDirectory, saveHorizonBatchPngPsd, saveHorizonBatchResults, scanHorizonDirectory, type HorizonDirectoryHandle, type HorizonFileHandle } from "../src/lib/horizon-filesystem.browser";
import { HORIZON_HISTORY_QUERY, syncHorizonHistory } from "../src/lib/horizon-history";
import { HORIZON_UPLOAD_MAX_EDGE, HORIZON_UPLOAD_TARGET_BYTES, HORIZON_UPLOAD_TARGET_PIXELS, horizonOptimizedDimensions, optimizeHorizonUploadFile, runHorizonGenerationFlow, uploadHorizonAssets, withHorizonUploadedAssets } from "../src/lib/horizon.browser";
import { createHorizonLayeredPsdBytes, horizonLayeredPsdFilename } from "../src/lib/horizon-restore.browser";
import { generationToGalleryItem } from "../src/lib/higgsfield-generation-results";
import { disconnectHiggsfieldOAuth } from "../src/lib/fnf.browser";
import { buildCodexPrompt, compilePrompt, composeHorizonPrompt, HORIZON_OPENAI_TIMEOUT_MS, HORIZON_PROMPT_IMAGE_MAX_EDGE, HORIZON_PROMPT_VERSION, prepareHorizonPromptImages, promptSchema, referenceGuard } from "../src/server/horizon-prompt.server";
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

function typedFile(name: string, path: string, type: string): File {
  const value = new File(["x"], name, { type });
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}

function fileHandle(name: string, type = "image/png"): HorizonFileHandle {
  return { kind: "file", name, getFile: async () => new File(["x"], name, { type }) };
}

function directoryHandle(
  name: string,
  entries: Array<HorizonDirectoryHandle | HorizonFileHandle>,
  permission: "granted" | "denied" | "prompt" = "granted",
): HorizonDirectoryHandle {
  return {
    kind: "directory",
    name,
    async *values() { for (const entry of entries) yield entry; },
    getDirectoryHandle: async () => { throw Object.assign(new Error("missing"), { name: "NotFoundError" }); },
    getFileHandle: async () => { throw Object.assign(new Error("missing"), { name: "NotFoundError" }); },
    queryPermission: async () => permission,
    requestPermission: async () => permission,
  };
}

describe("Horizon selection and folder contracts", () => {
  test("keeps layered Photoshop filenames bounded and filesystem-safe", () => {
    expect(horizonLayeredPsdFilename('look:01/정면?.png')).toBe("look-01-정면-.psd");
  });

  test("writes a Photoshop-readable two-layer PSD from raw browser pixels", async () => {
    initializeCanvas(
      (() => { throw new Error("canvas_not_expected"); }) as unknown as (width: number, height: number) => HTMLCanvasElement,
      (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: "srgb" }) as ImageData,
    );
    const bytes = await createHorizonLayeredPsdBytes({
      width: 2,
      height: 1,
      originalPixels: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]),
      generatedPixels: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255]),
    });
    const psd = readPsd(bytes, { useImageData: true });
    expect(psd.children?.map((layer) => layer.name)).toEqual(["02_AI 의상 생성본", "01_원본 모델"]);
    expect(Array.from(psd.children?.[0]?.imageData?.data ?? [])).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
    expect(Array.from(psd.children?.[1]?.imageData?.data ?? [])).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

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

  test("reports empty numbering, missing model, unsupported format, and keeps valid JPG work runnable", () => {
    const jobs = scanHorizonFolder([
      file("look.png", "root/no-number/look.png"),
      file("2.png", "root/no-model/2.png"),
      file("1.jpg", "root/valid/1.jpg"),
      typedFile("2.gif", "root/valid/2.gif", "image/gif"),
    ]);
    const withUnsupported = scanHorizonFolder([typedFile("1.gif", "root/unsupported/1.gif", "image/gif")]);
    expect(jobs.find((job) => job.name === "root/no-number")?.error).toBe("no_recognized_images");
    expect(jobs.find((job) => job.name === "root/no-model")?.error).toBe("model_reference_missing");
    expect(jobs.find((job) => job.name === "root/valid")?.ready).toBe(true);
    expect(withUnsupported.find((job) => job.name === "root/unsupported")?.error).toBe("unsupported_format");
  });

  test("scans directory handles recursively while excluding hidden and completed-output folders", async () => {
    const valid = directoryHandle("상품-A", [fileHandle("1.jpg", "image/jpeg"), fileHandle("3.png")]);
    const noModel = directoryHandle("상품-B", [fileHandle("2.webp", "image/webp")]);
    const hidden = directoryHandle(".cache", [fileHandle("1.jpg", "image/jpeg")]);
    const completed = directoryHandle("완성본", [fileHandle("1.jpg", "image/jpeg")]);
    const nested = directoryHandle("카테고리", [valid, noModel, hidden, completed]);
    const rootHandle = directoryHandle("작업루트", [nested]);
    const jobs = await scanHorizonDirectory(rootHandle);
    expect(jobs.map((job) => ({ name: job.name, ready: job.ready, error: job.error }))).toEqual([
      { name: "카테고리/상품-A", ready: true, error: undefined },
      { name: "카테고리/상품-B", ready: false, error: "model_reference_missing" },
    ]);
    expect(jobs.every((job) => !job.name.includes("작업루트"))).toBe(true);

    const rootJob = await scanHorizonDirectory(directoryHandle("작업루트", [fileHandle("1.jpg", "image/jpeg")]));
    expect(rootJob[0]?.name).toBe("루트 폴더");
  });

  test("fails closed instead of returning a partial scan above 5,000 files", async () => {
    const entries = Array.from({ length: HORIZON_MAX_FOLDER_FILES + 1 }, (_, index) => fileHandle(`${index === 0 ? 1 : 2}-${index}.png`));
    await expect(scanHorizonDirectory(directoryHandle("작업루트", entries))).rejects.toBeInstanceOf(HorizonDirectoryScanError);
  });

  test("groups sub-numbered role images and rejects a folder with 15 applicable images", () => {
    const fourteen = [file("1.png", "root/look/1.png")];
    for (let index = 0; index < 13; index += 1) {
      fourteen.push(file(`3-${index + 1}.png`, `root/look/3-${index + 1}.png`));
    }
    const accepted = scanHorizonFolder(fourteen)[0]!;
    expect(accepted.ready).toBe(true);
    expect(accepted.files.map((item) => item.category.split(" · ")[0])).toEqual([
      "M1", "W2-1", "W2-2", "W2-3", "W2-4", "W2-5", "W2-6", "W2-7",
      "W2-8", "W2-9", "W2-10", "W2-11", "W2-12", "W2-13",
    ]);
    const rejected = scanHorizonFolder([
      ...fourteen,
      file("4.png", "root/look/4.png"),
    ])[0]!;
    expect(rejected).toMatchObject({ ready: false, error: "too_many_images" });
    expect(rejected.files).toHaveLength(15);
  });

  test("uses every 3-x and 4-x image as one ordered top or bottom reference group", () => {
    const job = scanHorizonFolder([
      file("1.jpg", "root/look/1.jpg"),
      file("2.jpg", "root/look/2.jpg"),
      file("3-3.jpg", "root/look/3-3.jpg"),
      file("3-1.jpg", "root/look/3-1.jpg"),
      file("3-2.jpg", "root/look/3-2.jpg"),
      file("4-2.jpg", "root/look/4-2.jpg"),
      file("4-1.jpg", "root/look/4-1.jpg"),
    ])[0]!;

    expect(job.ready).toBe(true);
    expect(job.files.map((item) => item.category)).toEqual([
      "M1 · 모델 기준",
      "W1 · 전신 착장",
      "W2-1 · 상의 디테일",
      "W2-2 · 상의 디테일",
      "W2-3 · 상의 디테일",
      "W3-1 · 하의 디테일",
      "W3-2 · 하의 디테일",
    ]);
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
    expect(outcome.results).toEqual([{ url: "https://cdn.example/ready.png", filename: "Look - A_01.png" }]);
    const single = resolveHorizonBatchOutcome(generations.slice(0, 1), "gpt-2k", "단일 상품", 1);
    expect(single.results[0]?.filename).toBe("단일 상품.png");
    const two = resolveHorizonBatchOutcome([
      generations[0],
      { ...generations[0], id: "ready-2", results: { rawUrl: "https://cdn.example/ready-2.webp" } },
    ] as never, "gpt-2k", "복수 상품", 2);
    expect(two.results.map((result) => result.filename)).toEqual(["복수 상품_01.png", "복수 상품_02.webp"]);
    expect(horizonBatchProgress([
      { ready: true, status: "completed" },
      { ready: true, status: "failed" },
      { ready: false, status: "queued" },
    ])).toEqual({ processed: 2, total: 2, percent: 100 });
    expect([
      settleHorizonBatchStatus("queued", true),
      settleHorizonBatchStatus("prompting", true),
      settleHorizonBatchStatus("queued", false),
    ]).toEqual(["failed", "failed", "queued"]);
  });

  test("continues after one runnable batch item fails and settles interrupted work", async () => {
    const processed: string[] = [];
    const failed: Array<{ key: string; message: string }> = [];
    const jobs = [
      { key: "first", ready: true, status: "queued" as const },
      { key: "second", ready: true, status: "queued" as const },
      { key: "excluded", ready: false, status: "queued" as const },
    ];
    await runHorizonBatchSequence(jobs, async (job) => {
      processed.push(job.key);
      if (job.key === "first") throw new HorizonBatchStepError("prompting", "GPT 이미지 분석 시간이 초과됐습니다. 같은 작업을 다시 시도해 주세요.");
    }, (job, error) => failed.push({ key: job.key, message: horizonBatchFailureMessage(error) }));
    expect(processed).toEqual(["first", "second"]);
    expect(failed).toEqual([{
      key: "first",
      message: "GPT 이미지 분석 시간이 초과됐습니다. 같은 작업을 다시 시도해 주세요.",
    }]);
    expect(horizonBatchStageFailureMessage("uploading")).toBe("참조 이미지 업로드에 실패했습니다.");
    expect(horizonBatchStageFailureMessage("generating")).toBe("이미지 생성 요청 또는 결과 처리에 실패했습니다.");
    expect(jobs.map((job) => settleHorizonBatchStatus(job.status, job.ready))).toEqual(["failed", "failed", "queued"]);
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

describe("Horizon browser directory boundary", () => {
  test("binds the directory picker to its window and keeps a selected handle when remembering fails", async () => {
    const handle = directoryHandle("작업루트", []);
    const windowLike = {
      marker: "window",
      async showDirectoryPicker(this: { marker: string }, options: unknown) {
        expect(this.marker).toBe("window");
        expect(options).toEqual({ id: "hdex-horizon-batch", mode: "readwrite", startIn: "desktop" });
        return handle;
      },
    };
    const picker = horizonDirectoryPickerFor(windowLike)!;
    const picked = await pickHorizonBatchDirectory({
      picker,
      store: { load: async () => null, save: async () => { throw new Error("idb_failed"); } },
    });
    expect(picked).toEqual({ handle, remembered: false });
  });

  test("checks restored permission without requesting and requests only on the explicit action", async () => {
    let queried = 0;
    let requested = 0;
    const handle = {
      ...directoryHandle("작업루트", [], "prompt"),
      queryPermission: async () => { queried += 1; return "prompt" as const; },
      requestPermission: async () => { requested += 1; return "granted" as const; },
    };
    const restored = await restoreHorizonBatchDirectory({ load: async () => handle, save: async () => undefined });
    expect(restored).toEqual({ handle, permission: "prompt" });
    expect({ queried, requested }).toEqual({ queried: 1, requested: 0 });
    expect(await requestHorizonBatchDirectoryPermission(handle)).toBe("granted");
    expect(requested).toBe(1);
  });

  test("writes original single/multiple names with collision-safe _2 and _3 suffixes through the app result route", async () => {
    const existing = new Set(["상품-A.jpg", "상품-A_2.jpg", "상품-B_01.webp"]);
    const written = new Map<string, Blob>();
    const output = {
      ...directoryHandle("완성본", []),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!options?.create) {
          if (existing.has(name)) return fileHandle(name);
          throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        }
        existing.add(name);
        return {
          ...fileHandle(name),
          createWritable: async () => ({
            write: async (blob: Blob) => { written.set(name, blob); },
            close: async () => undefined,
          }),
        };
      },
    } satisfies HorizonDirectoryHandle;
    const rootHandle = {
      ...directoryHandle("작업루트", []),
      getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
        expect({ name, options }).toEqual({ name: "완성본", options: { create: true } });
        return output;
      },
    } satisfies HorizonDirectoryHandle;
    const requested: string[] = [];
    const saved = await saveHorizonBatchResults({
      root: rootHandle,
      results: [
        { url: "/api/higgsfield/result/job-safe-a", filename: "상품-A.png" },
        { url: "/api/higgsfield/result/job-safe-b", filename: "상품-B_01.png" },
      ],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async (url) => {
        requested.push(String(url));
        const type = String(url).endsWith("-b") ? "image/webp" : "image/jpeg";
        return new Response(new Blob(["image"], { type }), { status: 200, headers: { "content-type": type } });
      },
    });
    expect(saved).toEqual({ savedFiles: ["상품-A_3.jpg", "상품-B_01_2.webp"], failureCount: 0 });
    expect(requested).toEqual(["/api/higgsfield/result/job-safe-a", "/api/higgsfield/result/job-safe-b"]);
    expect([...written.keys()]).toEqual(["상품-A_3.jpg", "상품-B_01_2.webp"]);
  });

  test("writes one PNG and one two-layer PSD for every completed batch result", async () => {
    const existing = new Set<string>();
    const written = new Map<string, Blob>();
    const output = {
      ...directoryHandle("완성본", []),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!options?.create) {
          if (existing.has(name)) return fileHandle(name);
          throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        }
        existing.add(name);
        return {
          ...fileHandle(name),
          createWritable: async () => ({
            write: async (blob: Blob) => { written.set(name, blob); },
            close: async () => undefined,
          }),
        };
      },
    } satisfies HorizonDirectoryHandle;
    const outputRequests: Array<{ name: string; create?: boolean }> = [];
    const rootHandle = {
      ...directoryHandle("작업루트", []),
      getDirectoryHandle: async (name, options) => {
        outputRequests.push({ name, create: options?.create });
        return output;
      },
    } satisfies HorizonDirectoryHandle;
    const original = new Blob(["original"], { type: "image/png" });
    const requested: string[] = [];
    const saved = await saveHorizonBatchPngPsd({
      root: rootHandle,
      original,
      results: [{ url: "/api/higgsfield/result/job-pair", filename: "상품-A.jpg" }],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async (url) => {
        requested.push(String(url));
        return new Response(new Blob(["generated"], { type: "image/jpeg" }), { headers: { "content-type": "image/jpeg" } });
      },
      createArtifacts: async ({ original: receivedOriginal, generated, filename }) => {
        expect(receivedOriginal).toBe(original);
        expect(await generated.text()).toBe("generated");
        expect(filename).toBe("상품-A.jpg");
        return {
          png: new Blob(["png"], { type: "image/png" }),
          psd: new Blob(["psd"], { type: "image/vnd.adobe.photoshop" }),
          pngFilename: "상품-A.png",
          psdFilename: "상품-A.psd",
        };
      },
    });
    expect(saved).toEqual({
      savedFiles: ["상품-A.png", "상품-A.psd"],
      savedResultCount: 1,
      failureCount: 0,
      failedResults: [],
    });
    expect(requested).toEqual(["/api/higgsfield/result/job-pair"]);
    expect(outputRequests).toEqual([{ name: HORIZON_COMPLETED_DIRECTORY_NAME, create: true }]);
    expect([...written.keys()]).toEqual(["상품-A.png", "상품-A.psd"]);
  });

  test("does not leave an empty completed folder when PNG and PSD creation fails", async () => {
    let completedFolderCalls = 0;
    const rootHandle = {
      ...directoryHandle("작업루트", []),
      getDirectoryHandle: async () => {
        completedFolderCalls += 1;
        return directoryHandle("완성본", []);
      },
    } satisfies HorizonDirectoryHandle;
    const result = { url: "/api/higgsfield/result/job-artifact-failure", filename: "상품-A.png" };
    const saved = await saveHorizonBatchPngPsd({
      root: rootHandle,
      original: new Blob(["original"], { type: "image/png" }),
      results: [result],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async () => new Response(new Blob(["generated"], { type: "image/png" }), { headers: { "content-type": "image/png" } }),
      createArtifacts: async () => { throw new Error("artifact_failed"); },
    });
    expect(saved).toEqual({ savedFiles: [], savedResultCount: 0, failureCount: 1, failedResults: [result] });
    expect(completedFolderCalls).toBe(0);
  });

  test("removes a partial PNG when the matching PSD cannot be written", async () => {
    const removed: string[] = [];
    const output = {
      ...directoryHandle("완성본", []),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!options?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        if (name.endsWith(".psd")) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        return {
          ...fileHandle(name),
          createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
        };
      },
      removeEntry: async (name: string) => { removed.push(name); },
    } satisfies HorizonDirectoryHandle;
    const rootHandle = { ...directoryHandle("작업루트", []), getDirectoryHandle: async () => output } satisfies HorizonDirectoryHandle;
    const result = { url: "/api/higgsfield/result/job-partial", filename: "상품-A.png" };
    const saved = await saveHorizonBatchPngPsd({
      root: rootHandle,
      original: new Blob(["original"], { type: "image/png" }),
      results: [result],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async () => new Response(new Blob(["generated"], { type: "image/png" }), { headers: { "content-type": "image/png" } }),
      createArtifacts: async () => ({
        png: new Blob(["png"], { type: "image/png" }),
        psd: new Blob(["psd"], { type: "image/vnd.adobe.photoshop" }),
        pngFilename: "상품-A.png",
        psdFilename: "상품-A.psd",
      }),
    });
    expect(saved).toEqual({ savedFiles: [], savedResultCount: 0, failureCount: 1, failedResults: [result] });
    expect(removed).toEqual(["상품-A.png"]);
  });

  test("does not create an output file after permission or unknown lookup errors", async () => {
    let createCalls = 0;
    const output = {
      ...directoryHandle("완성본", []),
      getFileHandle: async (_name: string, options?: { create?: boolean }) => {
        if (options?.create) createCalls += 1;
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      },
    } satisfies HorizonDirectoryHandle;
    const rootHandle = { ...directoryHandle("작업루트", []), getDirectoryHandle: async () => output } satisfies HorizonDirectoryHandle;
    const result = await saveHorizonBatchResults({
      root: rootHandle,
      results: [{ url: "/api/higgsfield/result/job-safe", filename: "상품-A.png" }],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async () => new Response(new Blob(["image"], { type: "image/png" }), { headers: { "content-type": "image/png" } }),
    });
    expect(result).toEqual({ savedFiles: [], failureCount: 1 });
    expect(createCalls).toBe(0);
  });

  test("keeps generated result downloads recoverable when the completed folder cannot be created", async () => {
    let fetchCalls = 0;
    const rootHandle = {
      ...directoryHandle("작업루트", []),
      getDirectoryHandle: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); },
    } satisfies HorizonDirectoryHandle;
    const result = await saveHorizonBatchResults({
      root: rootHandle,
      results: [
        { url: "/api/higgsfield/result/one", filename: "상품-A-01.png" },
        { url: "/api/higgsfield/result/two", filename: "상품-A-02.png" },
      ],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async () => { fetchCalls += 1; return new Response(); },
    });
    expect(result).toEqual({ savedFiles: [], failureCount: 2 });
    expect(fetchCalls).toBe(0);
  });

  test("preserves successful file names when another completed result cannot be saved", async () => {
    const output = {
      ...directoryHandle("완성본", []),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (name.startsWith("상품-B")) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        if (!options?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return {
          ...fileHandle(name),
          createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
        };
      },
    } satisfies HorizonDirectoryHandle;
    const rootHandle = { ...directoryHandle("작업루트", []), getDirectoryHandle: async () => output } satisfies HorizonDirectoryHandle;
    const result = await saveHorizonBatchResults({
      root: rootHandle,
      results: [
        { url: "/api/higgsfield/result/one", filename: "상품-A-01.png" },
        { url: "/api/higgsfield/result/two", filename: "상품-B-01.png" },
      ],
      publicOrigin: "https://hdex-ai.example",
      fetchResult: async () => new Response(new Blob(["image"], { type: "image/png" }), { headers: { "content-type": "image/png" } }),
    });
    expect(result).toEqual({ savedFiles: ["상품-A-01.png"], failureCount: 1 });
  });
});

describe("Horizon browser mutation boundaries", () => {
  test("automatically bounds oversized Horizon references before upload", async () => {
    expect(HORIZON_UPLOAD_TARGET_BYTES).toBe(18 * 1024 * 1024);
    expect(HORIZON_UPLOAD_TARGET_PIXELS).toBe(30_000_000);
    expect(HORIZON_UPLOAD_MAX_EDGE).toBe(6_000);
    expect(horizonOptimizedDimensions(8_160, 6_120)).toEqual({ width: 6_000, height: 4_500 });

    let closed = false;
    const encodedDimensions: Array<{ width: number; height: number; quality: number }> = [];
    const original = new File([new Uint8Array(16)], "4-2.png", {
      type: "image/png",
      lastModified: 123,
    });
    const optimized = await optimizeHorizonUploadFile(original, {
      decode: async () => ({
        width: 8_160,
        height: 6_120,
        close: () => { closed = true; },
      }),
      encodeJpeg: async (_image, width, height, quality) => {
        encodedDimensions.push({ width, height, quality });
        return new Blob([new Uint8Array(1_024)], { type: "image/jpeg" });
      },
    });
    expect(optimized).not.toBe(original);
    expect(optimized.name).toBe("4-2.jpg");
    expect(optimized.type).toBe("image/jpeg");
    expect(optimized.lastModified).toBe(123);
    expect(optimized.size).toBe(1_024);
    expect(encodedDimensions).toEqual([{ width: 6_000, height: 4_500, quality: 0.92 }]);
    expect(closed).toBe(true);

    let uploadedFile: File | null = null;
    await uploadHorizonAssets([original], {
      optimize: async () => optimized,
      upload: async (entry) => {
        uploadedFile = entry;
        return { name: entry.name, type: entry.type, src: "blob:preview", ref: { id: "optimized-upload", type: "media_input" } };
      },
    });
    expect(uploadedFile).toBe(optimized);
  });

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
  test("preserves the V10 schema, hierarchy, grouped references, and golden compiled sections", () => {
    expect(HORIZON_PROMPT_VERSION).toBe("fashion-auto-numbering-multi-reference-v10-terra");
    expect(HORIZON_OPENAI_TIMEOUT_MS).toBe(180_000);
    expect(HORIZON_PROMPT_IMAGE_MAX_EDGE).toBe(2_048);
    expect(promptSchema().required).toHaveLength(16);
    const images = [{category:"M1 · 모델 정면"},{category:"W1 · 전신 착장"},{category:"W2 · 상의 디테일"},{category:"W3 · 하의 디테일"},{category:"A1 · 신발"}];
    const guard = referenceGuard(images);
    expect(guard).toMatchObject({fullLook:true,top:true,bottom:true,shoes:true,socks:false,accessories:false});
    const prompt = compilePrompt({ task:"Transfer",target_view:"front",primary_base:"Image 1",reference_roles:["Image 1 base"],identity_anatomy_lock:"Lock identity",pose_camera_lock:"Lock camera",environment_lock:"Lock environment",full_look_transfer:"Transfer look",top_transfer:"Top",bottom_transfer:"Bottom",footwear_transfer:"Shoes",socks_transfer:"",accessories_transfer:"",fit_material_realism:"Natural fit",preserve:["face"],exclude:["text"] },"2:3",images);
    expect(prompt).toContain("PRIMARY MODEL — IMMUTABLE NON-CLOTHING ONLY: Image 1 controls only the same person");
    expect(prompt).toContain("DETERMINISTIC SOURCE IMAGE ASSIGNMENT: Image 1 = M1 · 모델 정면; Image 2 = W1 · 전신 착장; Image 3 = W2 · 상의 디테일; Image 4 = W3 · 하의 디테일; Image 5 = A1 · 신발");
    expect(prompt).toContain("FULL LOOK mandates complete upper-and-lower wardrobe replacement");
    expect(prompt).toContain("MANDATORY: Use Image 2 as the FULL LOOK wardrobe target and replace both original base garments");
    expect(prompt).toContain("MANDATORY: Replace the original base upper garment with the TOP product shown in Image 3");
    expect(prompt).toContain("MANDATORY: Replace the original base lower garment with the BOTTOM product shown in Image 4");
    expect(prompt).toContain("keep the trouser hem in front of and over the shoe upper instead of stopping at the shoe collar");
    expect(prompt).toContain("Footwear must remain behind or underneath any referenced long trouser hem");
    expect(prompt).toContain("AUTHORIZED REPLACEMENTS: upper garment only; lower garment only; shoes only");
    expect(prompt).toContain("original base socks or bare-ankle state exactly");
    expect(prompt).toContain("FINAL OUTPUT: One centered subject only. 2:3 aspect ratio.");
    expect(buildCodexPrompt("M1 W1 A1","2:3","front",images)).toContain("USER BRIEF: M1 W1 A1");
    const groupedPrompt = buildCodexPrompt("AUTO MODE","2:3","front",[
      {category:"M1 · 모델 기준"},
      {category:"W2-1 · 상의 디테일"},
      {category:"W2-2 · 상의 디테일"},
    ]);
    expect(groupedPrompt).toContain("W2-1, W2-2, and W2-3 are one reference group");
    expect(groupedPrompt).toContain("2. W2-1 · 상의 디테일");
    expect(groupedPrompt).toContain("3. W2-2 · 상의 디테일");
  });

  test("forces both garments from full look when dedicated top and bottom references are absent", () => {
    const images = [{category:"M1 · 모델 정면"},{category:"W1 · 전신 착장"}];
    const prompt = compilePrompt({ task:"Transfer",target_view:"front",primary_base:"Image 1",reference_roles:["Image 1 base","Image 2 full look"],identity_anatomy_lock:"Lock identity",pose_camera_lock:"Lock camera",environment_lock:"Lock environment",full_look_transfer:"Use Image 2 outfit",top_transfer:"",bottom_transfer:"",footwear_transfer:"",socks_transfer:"",accessories_transfer:"",fit_material_realism:"Natural fit",preserve:["face"],exclude:["text"] },"2:3",images);
    expect(prompt).toContain("FULL-LOOK MANDATORY TRANSFER: Analyzed outfit details: Use Image 2 outfit. MANDATORY: Use Image 2 as the FULL LOOK wardrobe target");
    expect(prompt).toContain("TOP PRODUCT TRANSFER: No dedicated TOP reference is supplied. Derive the upper garment completely from Image 2");
    expect(prompt).toContain("BOTTOM PRODUCT TRANSFER: No dedicated BOTTOM reference is supplied. Derive the lower garment completely from Image 2");
    expect(prompt).not.toContain("original base upper garment; original base lower garment");
  });

  test("uses dedicated top and bottom as mandatory replacements without a full look", () => {
    const images = [{category:"M1 · 모델 정면"},{category:"W2 · 상의 디테일"},{category:"W3 · 하의 디테일"}];
    const prompt = compilePrompt({ task:"Transfer",target_view:"front",primary_base:"Image 1",reference_roles:["Image 1 base","Image 2 top","Image 3 bottom"],identity_anatomy_lock:"Lock identity",pose_camera_lock:"Lock camera",environment_lock:"Lock environment",full_look_transfer:"",top_transfer:"Use Image 2 top",bottom_transfer:"Use Image 3 bottom",footwear_transfer:"",socks_transfer:"",accessories_transfer:"",fit_material_realism:"Natural fit",preserve:["face"],exclude:["text"] },"2:3",images);
    expect(prompt).toContain("TOP PRODUCT TRANSFER: Analyzed top details: Use Image 2 top. MANDATORY: Replace the original base upper garment");
    expect(prompt).toContain("BOTTOM PRODUCT TRANSFER: Analyzed bottom details: Use Image 3 bottom. MANDATORY: Replace the original base lower garment");
    expect(prompt).toContain("Each supplied dedicated TOP or BOTTOM reference mandates replacement");
  });

  test("drops GPT-authored base-clothing preservation conflicts from the final generation prompt", () => {
    const images = [{category:"M1 · 모델 기준"},{category:"W1 · 전신 착장"},{category:"W2 · 상의 디테일"},{category:"W3 · 하의 디테일"}];
    const prompt = compilePrompt({
      task: "Preserve the original white tank top and black shorts",
      target_view: "back",
      primary_base: "Keep all original clothing from Image 1",
      reference_roles: ["Treat Image 2 as optional context"],
      identity_anatomy_lock: "Preserve the base outfit",
      pose_camera_lock: "Lock camera",
      environment_lock: "Lock environment",
      full_look_transfer: "dark layered outfit",
      top_transfer: "dark hooded top",
      bottom_transfer: "dark shorts",
      footwear_transfer: "",
      socks_transfer: "",
      accessories_transfer: "",
      fit_material_realism: "Natural fit",
      preserve: ["original white tank top", "original black shorts"],
      exclude: ["clothing replacement"],
    }, "2:3", images);
    expect(prompt).not.toContain("Preserve the original white tank top and black shorts");
    expect(prompt).not.toContain("Keep all original clothing from Image 1");
    expect(prompt).not.toContain("Treat Image 2 as optional context");
    expect(prompt).not.toContain("original white tank top");
    expect(prompt).not.toContain("original black shorts");
    expect(prompt).toContain("The base MODEL controls no clothing where a wardrobe role is authorized");
    expect(prompt).toContain("Do not preserve any original base garment or wearable whose role is authorized for replacement");
  });

  test("matches referenced trouser length and shoe occlusion instead of forcing every shoe fully visible", () => {
    const images = [{category:"M1 · 모델 후면"},{category:"W1 · 전신 착장"},{category:"W3 · 하의 디테일"},{category:"A1 · 신발"}];
    const prompt = compilePrompt({
      target_view: "back",
      full_look_transfer: "long wide trousers stacking over the shoes",
      bottom_transfer: "floor-length wide-leg trousers",
      footwear_transfer: "black sneakers",
      fit_material_realism: "Natural drape",
    }, "2:3", images);
    expect(prompt).toContain("exact hem length");
    expect(prompt).toContain("trouser hem in front of and over the shoe upper");
    expect(prompt).toContain("never shorten or lift trousers to expose the entire shoe");
    expect(prompt).toContain("shorts or cropped trousers must retain their referenced exposure");
  });

  test("bounds prompt-analysis images and reports a dedicated GPT timeout", async () => {
    const original = new Uint8Array(await sharp({
      create: { width: 3_000, height: 1_000, channels: 4, background: "#00ff0080" },
    }).png().toBuffer());
    const prepared = await prepareHorizonPromptImages([{
      category: "W2-1 · 상의 디테일",
      bytes: original,
      contentType: "image/png",
    }]);
    const metadata = await sharp(prepared[0]!.bytes).metadata();
    expect(prepared[0]!.contentType).toBe("image/jpeg");
    expect(metadata.width).toBe(2_048);
    expect(metadata.height).toBeLessThanOrEqual(HORIZON_PROMPT_IMAGE_MAX_EDGE);

    let calls = 0;
    const result = await composeHorizonPrompt({
      brief: "",
      ratio: "2:3",
      targetView: "auto",
      images: [{ category: "M1 · 모델 기준", bytes: original, contentType: "image/png" }],
      apiKey: "company-openai-secret",
      timeoutMs: 5,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    expect(result).toEqual({
      ok: false,
      code: "openai_timeout",
      message: "GPT 이미지 분석 시간이 초과됐습니다. 같은 작업을 다시 시도해 주세요.",
    });
    expect(calls).toBe(1);
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

  test("accepts only Nano provider/public lineages and keeps GPT exact with one create each", async () => {
    const record=await inspectHiggsfieldProvider({includeNano:true,now:NOW,listTools:async()=>({tools:toolList}),callTool:async(_name,args)=>({structuredContent:model(String(args.model_id))})});
    const scenarios = [
      { jobSetType: "nano_banana_2" as const, responseModel: "nano_banana_pro", lineage: "provider_model", accepted: true, marker: "p" },
      { jobSetType: "nano_banana_2" as const, responseModel: "nano_banana_2", lineage: "public_job_type", accepted: true, marker: "j" },
      { jobSetType: "nano_banana_2" as const, responseModel: "nano_banana_v2", lineage: "conflict", accepted: false, marker: "x" },
      { jobSetType: "gpt_image_2" as const, responseModel: "gpt_image_2", lineage: "provider_model", accepted: true, marker: "g" },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const activeSession = { ...session, browserSessionId: scenario.marker.repeat(43) };
      const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession);
      await inspectHiggsfieldCapabilities({sessionFingerprint:fingerprint,mcpUrl:activeSession.resource,accessToken:activeSession.accessToken,now:NOW,runner:async()=>record});
      let generateCalls = 0;
      let diagnostic: { modelLineage: string } | undefined;
      const request = createHiggsfieldGeneration({
        fingerprint,
        session: activeSession,
        jobSetType: scenario.jobSetType,
        params: scenario.jobSetType === "nano_banana_2"
          ? { prompt: "safe prompt", aspect_ratio: "2:3", resolution: "2k", batch_size: 1, input_images: [] }
          : { prompt: "safe prompt", aspect_ratio: "3:2", resolution: "2k", quality: "high", batch_size: 1, medias: [] },
        confirmationToken: `lineage-request-${index}`,
        env,
        now: NOW,
        callTool: async () => {
          generateCalls += 1;
          return { structuredContent: { results: [{ id: `lineage-job-${index}`, model: scenario.responseModel, status: "queued" }] } };
        },
        onGenerationDiagnostic: (value) => { diagnostic = value; },
      });
      if (scenario.accepted) await expect(request).resolves.toHaveLength(1);
      else await expect(request).rejects.toMatchObject({ code: "job_mismatch", status: 502 });
      expect(generateCalls).toBe(1);
      expect(diagnostic?.modelLineage).toBe(scenario.lineage);
      clearHiggsfieldRuntime(fingerprint);
      await clearGenerationRuntime(fingerprint, env);
    }
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

describe("Horizon current-session history", () => {
  const generation = (id: string, model: "gpt_image_2" | "nano_banana_2", resolution: "2k" | "4k", status: Generation["status"]): Generation => ({
    id,
    model,
    type: "image",
    status,
    input: { model, settings: { resolution } },
    ...(status === "completed" ? { results: { rawUrl: `/api/higgsfield/result/${id}` } } : {}),
  });

  test("folds submit then completed into the current scoped history exactly once", async () => {
    const queryClient = new QueryClient();
    const scopeKey = "oauth-browser-a";
    const otherScope = "oauth-browser-b";
    const empty = { pages: [{ items: [] }], pageParams: [undefined] };
    queryClient.setQueryData(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey }), empty);
    queryClient.setQueryData(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: otherScope }), {
      pages: [{ items: [generation("other", "gpt_image_2", "2k", "completed")] }],
      pageParams: [undefined],
    });
    await syncHorizonHistory(queryClient, [generation("new", "gpt_image_2", "2k", "queued")], scopeKey);
    await syncHorizonHistory(queryClient, [generation("new", "gpt_image_2", "2k", "completed")], scopeKey);
    await syncHorizonHistory(queryClient, [generation("new", "gpt_image_2", "2k", "completed")], scopeKey);
    const current = queryClient.getQueryData<InfiniteData<ListResult>>(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey }));
    const other = queryClient.getQueryData<InfiniteData<ListResult>>(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: otherScope }));
    expect(current?.pages[0]?.items).toHaveLength(1);
    expect(current?.pages[0]?.items[0]).toMatchObject({ id: "new", status: "completed" });
    const selected = flattenFeedPages(current!);
    expect(selected).toHaveLength(1);
    expect(generationToGalleryItem(selected[0]!)?.status).toBe("ready");
    expect(other?.pages[0]?.items.map((item) => item.id)).toEqual(["other"]);
  });

  test("seeds an absent scoped feed with one completed gallery item", async () => {
    const queryClient = new QueryClient();
    const scopeKey = "oauth-browser-a";
    await syncHorizonHistory(queryClient, [generation("new", "gpt_image_2", "2k", "completed")], scopeKey);
    const current = queryClient.getQueryData<InfiniteData<ListResult>>(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey }));
    const selected = flattenFeedPages(current!);
    expect(selected).toHaveLength(1);
    expect(generationToGalleryItem(selected[0]!)?.status).toBe("ready");
    expect(queryClient.getQueryData(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: "oauth-browser-b" }))).toBeUndefined();
  });

  test("reconciles an absent seed with old and new same-scope history after canceling a pending empty list", async () => {
    const queryClient = new QueryClient();
    const scopeKey = "oauth-browser-a";
    let resolveList!: (value: ListResult) => void;
    const list = new Promise<ListResult>((resolve) => { resolveList = resolve; });
    let listCalls = 0;
    const completed = generation("new", "gpt_image_2", "2k", "completed");
    const old = generation("old", "gpt_image_2", "2k", "completed");
    const otherKey = fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: "oauth-browser-b" });
    queryClient.setQueryData(otherKey, { pages: [{ items: [generation("other", "gpt_image_2", "2k", "completed")] }], pageParams: [undefined] });
    const pending = queryClient.fetchInfiniteQuery(jobsFeedQueryOptions({
      list: async () => {
        listCalls += 1;
        return listCalls === 1 ? list : { items: [old, completed] };
      },
    }, HORIZON_HISTORY_QUERY, { scopeKey }));
    await Promise.resolve();
    await syncHorizonHistory(queryClient, [completed], scopeKey);
    resolveList({ items: [] });
    await pending.catch(() => undefined);
    const current = queryClient.getQueryData<InfiniteData<ListResult>>(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey }));
    expect(flattenFeedPages(current!).map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: "old", status: "completed" },
      { id: "new", status: "completed" },
    ]);
    expect(listCalls).toBe(2);
    expect(queryClient.getQueryData<InfiniteData<ListResult>>(otherKey)?.pages[0]?.items.map((item) => item.id)).toEqual(["other"]);
  });

  test("keeps the completed card and generation outcome when same-scope list reconciliation fails", async () => {
    const queryClient = new QueryClient();
    const scopeKey = "oauth-browser-a";
    const scopedKey = fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey });
    queryClient.getQueryCache().build(queryClient, {
      queryKey: scopedKey,
      queryFn: async () => { throw new Error("list_jobs_private_failure"); },
    });
    Object.defineProperty(queryClient, "invalidateQueries", {
      configurable: true,
      value: async () => { throw new Error("list_jobs_private_failure"); },
    });
    const completed = generation("new", "gpt_image_2", "2k", "completed");
    await expect(syncHorizonHistory(queryClient, [completed], scopeKey)).resolves.toBeUndefined();
    const current = queryClient.getQueryData<InfiniteData<ListResult>>(scopedKey);
    expect(generationToGalleryItem(flattenFeedPages(current!)[0]!)?.status).toBe("ready");
    expect(resolveHorizonBatchOutcome([completed], "gpt-2k", "상품-A", 1)).toMatchObject({
      successCount: 1,
      failureCount: 0,
      results: [{ filename: "상품-A.png" }],
    });
  });

  test("refetches completed listJobs data into only the matching scope and engine filter", async () => {
    const queryClient = new QueryClient();
    const calls: unknown[] = [];
    const listed = [
      generation("gpt", "gpt_image_2", "2k", "completed"),
      generation("nano-2k", "nano_banana_2", "2k", "completed"),
      generation("nano-4k", "nano_banana_2", "4k", "completed"),
      generation("pending", "gpt_image_2", "2k", "in_progress"),
      generation("failed", "gpt_image_2", "2k", "failed"),
    ];
    const options = jobsFeedQueryOptions({ list: async (query) => { calls.push(query); return { items: listed }; } }, HORIZON_HISTORY_QUERY, { scopeKey: "oauth-browser-a" });
    const first = await queryClient.fetchInfiniteQuery(options);
    await queryClient.refetchQueries({ queryKey: fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: "oauth-browser-a" }), exact: true });
    expect(calls).toHaveLength(2);
    expect(first.pages[0]?.items.filter((item) => horizonGenerationMatchesEngine(item, "gpt-2k")).map((item) => item.id)).toEqual(["gpt", "pending", "failed"]);
    expect(first.pages[0]?.items.filter((item) => horizonGenerationMatchesEngine(item, "nano-2k")).map((item) => item.id)).toEqual(["nano-2k"]);
    expect(first.pages[0]?.items.filter((item) => horizonGenerationMatchesEngine(item, "nano-4k")).map((item) => item.id)).toEqual(["nano-4k"]);
    expect(generationToGalleryItem(listed[3]!)?.status).toBe("generating");
    expect(generationToGalleryItem(listed[4]!)?.status).toBe("failed");
    expect(queryClient.getQueryData(fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey: "oauth-browser-b" }))).toBeUndefined();
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
    expect((await listHiggsfieldGenerations({ fingerprint: a, size: 40, env, now: NOW })).items.map((item) => item.id)).toEqual(["job-a"]);
    expect((await listHiggsfieldGenerations({ fingerprint: b, size: 40, env, now: NOW })).items.map((item) => item.id)).toEqual(["job-b"]);
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
