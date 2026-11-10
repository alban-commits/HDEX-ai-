import { readdir, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { composeInfluencerProfile } from "../src/lib/profile.functions";
import { BASE_PROFILE } from "../src/data/base-profile";
import { downloadResultThroughTemporaryFile, MAX_RESULT_BYTES, RESULT_DOWNLOAD_TIMEOUT_MS } from "../src/server/result-download.server";
import { handleHiggsfieldUpload } from "../src/server/higgsfield-upload-route.server";
import { handleOpenAiProfile } from "../src/server/openai-profile-route.server";
import { getRuntimeReadiness, getTemporaryStorageConfig } from "../src/server/runtime-config.server";
import {
  sweepExpiredTemporaryStorage,
  withTemporaryFile,
} from "../src/server/temporary-storage.server";
import {
  isPrivateAddress,
  validatePublicHttpsTarget,
} from "../src/server/pinned-https.server";

async function pngFixture(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#ffffff" },
  }).png().toBuffer());
}

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) =>
    entry.isDirectory() ? filesBelow(join(path, entry.name)) : [join(path, entry.name)]));
  return nested.flat();
}

describe("server OpenAI image input boundary", () => {
  test("does not use the company OpenAI boundary without a Higgsfield OAuth session", async () => {
    const response = await handleOpenAiProfile(
      new Request("https://hdex-ai.company.example/api/openai/profile", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-hdex-api-response")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "oauth_required" });
  });

  test("marks an unauthenticated media upload as an app JSON response", async () => {
    const response = await handleHiggsfieldUpload(
      new Request("https://hdex-ai.company.example/api/media/upload", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-hdex-api-response")).toBe("1");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "oauth_required" },
    });
  });

  test("sends local references and the uploaded pose as bytes without exposing the internal URL", async () => {
    const publicDirectory = await mkdtemp(join(tmpdir(), "hdex-openai-test-"));
    await mkdir(join(publicDirectory, "references"));
    await writeFile(join(publicDirectory, "references", "fixture.png"), await pngFixture());
    let requestBody = "";
    let authorization = "";
    try {
      const result = await composeInfluencerProfile({
        data: {
          gender: "female",
          environment: "Studio",
          scene: "Standing",
          imageType: "Editorial",
          referenceImageUrls: ["https://hdex-ai.company.example/references/fixture.png"],
        },
        pose: { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" },
        publicOrigin: "https://hdex-ai.company.example",
        publicDirectory,
        apiKey: "company-openai-secret",
        fetchImpl: async (_input, init) => {
          requestBody = String(init?.body);
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return Response.json({ output_text: '{"master_prompt":"safe prompt"}' });
        },
      });
      expect(result).toEqual({ ok: true, profile: { master_prompt: "safe prompt" } });
      const payload = JSON.parse(requestBody) as Record<string, unknown>;
      expect(payload.model).toBe("gpt-5.6-terra");
      expect(payload.text).toEqual({ format: { type: "json_object" } });
      const content = (
        payload.input as Array<{ content: Array<{ type: string; text?: string }> }>
      )[0]!.content;
      expect(content[0]?.text).toBe(
        [
          "Create one complete JSON object using the supplied BASE JSON as the exact structural template.",
          "Subject: a genuinely fit Korean female influencer in her twenties, naturally attractive, healthy, energetic and confident.",
          "Environment category: Studio. Scene/action category: Standing.",
          "Image treatment: Editorial.",
          "Analyze the supplied pose image ONLY for body orientation, weight distribution, head direction, gaze, arms, hands, legs, feet, camera viewpoint and crop. Do not copy identity, face, clothes, text, background or layout.",
          "The resulting master_prompt is for Higgsfield Soul 2 text-to-image. Exactly one person appears exactly once in one continuous undivided photograph.",
          "No split screen, collage, repeated subject, contact sheet, social-media interface, text, logo, watermark or readable signage.",
          "Keep the setting and action faithful to the selected categories but allow natural location and pose variation that real Korean influencers would post.",
          "Use English for every generated prompt string. Return JSON only.",
          `BASE JSON:\n${JSON.stringify(BASE_PROFILE)}`,
        ].join("\n\n"),
      );
      expect(requestBody.match(/data:image\/(?:png|jpeg);base64,/g)).toHaveLength(2);
      expect(requestBody).not.toContain("https://hdex-ai.company.example/references/");
      expect(requestBody).not.toContain("company-openai-secret");
      expect(authorization).toBe("Bearer company-openai-secret");
    } finally {
      await rm(publicDirectory, { recursive: true, force: true });
    }
  });

  test("rejects a reference URL outside the fixed public origin before OpenAI is called", async () => {
    let calls = 0;
    await expect(
      composeInfluencerProfile({
        data: {
          gender: "male",
          environment: "Studio",
          scene: "Standing",
          imageType: "Editorial",
          referenceImageUrls: ["https://attacker.example/references/fixture.png"],
        },
        pose: { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" },
        publicOrigin: "https://hdex-ai.company.example",
        publicDirectory: "/does/not/matter",
        apiKey: "company-openai-secret",
        fetchImpl: async () => {
          calls += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("지원되지 않는 폴더 레퍼런스 주소입니다.");
    expect(calls).toBe(0);
  });

  test("normalizes an OpenAI transport failure without retrying or exposing the key", async () => {
    const publicDirectory = await mkdtemp(join(tmpdir(), "hdex-openai-failure-test-"));
    await mkdir(join(publicDirectory, "references"));
    let calls = 0;
    try {
      const result = await composeInfluencerProfile({
        data: {
          gender: "male",
          environment: "Studio",
          scene: "Standing",
          imageType: "Editorial",
          referenceImageUrls: [],
        },
        pose: { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" },
        publicOrigin: "https://hdex-ai.company.example",
        publicDirectory,
        apiKey: "company-openai-secret",
        fetchImpl: async () => {
          calls += 1;
          throw new Error("raw network error containing company-openai-secret");
        },
      });
      expect(result).toEqual({
        ok: false,
        code: "openai_error",
        message: "GPT JSON 생성 요청에 실패했습니다. API 키와 사용 한도를 확인해주세요.",
      });
      expect(JSON.stringify(result)).not.toContain("company-openai-secret");
      expect(calls).toBe(1);
    } finally {
      await rm(publicDirectory, { recursive: true, force: true });
    }
  });
});

describe("temporary result download boundary", () => {
  test("allows bounded large 4K image results for PNG and PSD export", () => {
    expect(MAX_RESULT_BYTES).toBe(80 * 1024 * 1024);
    expect(RESULT_DOWNLOAD_TIMEOUT_MS).toBe(120_000);
  });

  test("returns browser bytes and removes every request-scoped temporary file in finally", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "hdex-result-test-parent-"));
    try {
      const image = await pngFixture();
      const response = await downloadResultThroughTemporaryFile({
        remoteUrl: "https://cdn.higgsfield.ai/private/result?signed=secret",
        jobId: "job-1",
        storageConfig: {
          baseDirectory: temporaryParent,
          rootDirectory: join(temporaryParent, "owned"),
          ttlMs: 60_000,
        },
        fetchImpl: async (_input, init) => {
          expect(init?.redirect).toBe("error");
          return new Response(image, {
            headers: { "Content-Type": "image/png", "Content-Length": String(image.byteLength) },
          });
        },
      });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
      expect(response.headers.get("content-disposition")).toContain("higgsfield-job-1.png");
      expect(JSON.stringify([...response.headers])).not.toContain("signed=secret");
      expect(await filesBelow(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("also cleans the temporary directory when the provider result is invalid", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "hdex-result-failure-test-"));
    try {
      await expect(
        downloadResultThroughTemporaryFile({
          remoteUrl: "https://cdn.higgsfield.ai/private/result",
          jobId: "job-2",
          storageConfig: {
            baseDirectory: temporaryParent,
            rootDirectory: join(temporaryParent, "owned"),
            ttlMs: 60_000,
          },
          fetchImpl: async () =>
            new Response(new Uint8Array([1]), { headers: { "Content-Type": "text/html" } }),
        }),
      ).rejects.toThrow("unsupported_result_type");
      expect(await filesBelow(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });
});

describe("TTL temporary storage boundary", () => {
  test("keeps request bytes under the app-owned root and cleans them after failure", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "hdex-temp-owned-"));
    const config = {
      baseDirectory,
      rootDirectory: join(baseDirectory, "hdex-influencer-frame"),
      ttlMs: 60_000,
    };
    try {
      await expect(
        withTemporaryFile({
          category: "uploads",
          sessionFingerprint: "session-a",
          extension: "png",
          bytes: await pngFixture(),
          config,
          operation: async (path) => {
            expect(path.startsWith(config.rootDirectory)).toBe(true);
            expect((await readFile(path)).byteLength).toBeGreaterThan(0);
            throw new Error("mock_upload_failed");
          },
        }),
      ).rejects.toThrow("mock_upload_failed");
      expect(await filesBelow(baseDirectory)).toEqual([]);
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });

  test("startup/periodic sweeps remove only expired app-owned metadata", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "hdex-temp-sweep-"));
    const config = {
      baseDirectory,
      rootDirectory: join(baseDirectory, "hdex-influencer-frame"),
      ttlMs: 60_000,
    };
    const oldFile = join(config.rootDirectory, "jobs", "old.json");
    const freshFile = join(config.rootDirectory, "jobs", "fresh.json");
    try {
      await mkdir(join(config.rootDirectory, "jobs"), { recursive: true });
      await writeFile(oldFile, "old");
      await writeFile(freshFile, "fresh");
      await utimes(oldFile, new Date(0), new Date(0));
      const removed = await sweepExpiredTemporaryStorage({ config, now: Date.now() });
      expect(removed).toBe(1);
      expect(await filesBelow(config.rootDirectory)).toEqual([freshFile]);
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });
});

test("Windows Node health readiness depends only on required server secrets and fixed origins", () => {
  const secret = Buffer.alloc(32, 9).toString("base64url");
  expect(
    getRuntimeReadiness({
      HDEX_PUBLIC_ORIGIN: "https://hdex-ai.company.example",
      HDEX_HIGGSFIELD_MCP_URL: "https://mcp.higgsfield.ai/mcp",
      HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET: secret,
      OPENAI_API_KEY: "server-only-key",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      HDEX_TEMP_DIR: "C:\\HDEX\\temp",
      HDEX_TEMP_TTL_SECONDS: "86400",
    } as NodeJS.ProcessEnv),
  ).toEqual({
    ready: true,
    checks: {
      nodeRuntime: true,
      nodeEnvironment: true,
      loopbackBind: true,
      publicOrigin: true,
      oauthCookieSecret: true,
      higgsfieldMcp: true,
      openAi: true,
      temporaryStorage: true,
      generationSwitch: true,
      generationEnabled: false,
    },
  });
});

test("preserves a Windows absolute temporary directory when checked on non-Windows CI", () => {
  expect(
    getTemporaryStorageConfig({
      HDEX_TEMP_DIR: "C:\\HDEX\\temp",
      HDEX_TEMP_TTL_SECONDS: "3600",
    } as NodeJS.ProcessEnv),
  ).toEqual({
    baseDirectory: "C:\\HDEX\\temp",
    rootDirectory: "C:\\HDEX\\temp\\hdex-influencer-frame",
    ttlMs: 3_600_000,
  });
});

describe("signed URL SSRF boundary", () => {
  test("rejects local, mapped, link-local, and NAT64-local addresses", () => {
    expect(
      [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "::1",
        "::ffff:127.0.0.1",
        "fe80::1",
        "64:ff9b::7f00:1",
      ].every(isPrivateAddress),
    ).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  test("pins only public DNS results and rejects any mixed private answer", async () => {
    const safe = await validatePublicHttpsTarget("https://uploads.example/private?signed=hidden", async () => [
      { address: "203.0.113.10", family: 4 },
    ]);
    expect(safe.url.hostname).toBe("uploads.example");
    expect(safe.addresses).toEqual([{ address: "203.0.113.10", family: 4 }]);
    await expect(
      validatePublicHttpsTarget("https://uploads.example/private", async () => [
        { address: "203.0.113.10", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("unsafe_https_address");
  });
});
