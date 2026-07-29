import { describe, expect, test } from "bun:test";
import { ApiJobError } from "@higgsfield/fnf/errors";
import {
  HDEX_ADAPTER_BODY_SENTINEL_KEY,
  HDEX_ADAPTER_BODY_SENTINEL_VALUE,
} from "../src/lib/app-api-contract";
import { finalizeNodeResponse, normalizeCatastrophicResponse } from "../src/server";
import { handleHiggsfieldAdapter } from "../src/server/higgsfield-adapter-route.server";
import { higgsfieldOAuthSessionFingerprint } from "../src/server/higgsfield-oauth.server";
import {
  clearHiggsfieldRuntime,
  inspectHiggsfieldCapabilities,
  type HiggsfieldCapabilityRecord,
} from "../src/server/higgsfield-mcp.server";
import type { ActiveOAuthSession } from "../src/server/oauth-routes.server";

const PUBLIC_ORIGIN = "https://hdex-ai.company.example";
const activeSession: ActiveOAuthSession = {
  config: {
    publicOrigin: PUBLIC_ORIGIN,
    callbackUrl: `${PUBLIC_ORIGIN}/api/higgsfield/oauth/callback`,
    mcpUrl: "https://mcp.higgsfield.ai/mcp",
    cookieSecret: new Uint8Array(32),
  },
  session: {
    schemaVersion: "hdex.higgsfield-oauth-session.v1",
    accessToken: "mock-private-access-token",
    refreshToken: "mock-private-refresh-token",
    clientId: "mock-private-client-id",
    tokenEndpoint: "https://auth.higgsfield.ai/token",
    resource: "https://mcp.higgsfield.ai/mcp",
    accessExpiresAt: Date.now() + 60_000,
    sessionExpiresAt: Date.now() + 120_000,
  },
};

function adapterRequest(body: string): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/higgsfield/adapter`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
    body,
  });
}

async function expectSafeJson(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-hdex-api-response")).toBe("1");
  return response.json() as Promise<Record<string, unknown>>;
}

function soulCapabilityRecord(now: number): HiggsfieldCapabilityRecord {
  return {
    checkedAt: now,
    expiresAt: now + 60_000,
    toolCount: 5,
    pageCount: 1,
    tools: [],
    models: [
      {
        key: "soul_2",
        displayName: "Soul 2",
        available: true,
        modelId: "soul_v2",
        modelName: "Higgsfield Soul 2.0",
        parameterOptions: {
          aspect_ratio: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"],
          quality: ["1.5k", "2k"],
        },
        aspectRatios: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"],
        aspectRatioParameter: "aspect_ratio",
        resolutionParameter: "quality",
        resolutionValue: "2k",
        mediaRole: "reference",
        maximumImages: 1,
        inputContractHash: "sha256:test-only-contract",
      },
    ],
  };
}

describe("Higgsfield adapter JSON boundary", () => {
  test("returns an unauthenticated adapter response as no-store JSON", async () => {
    const diagnostics: string[] = [];
    const response = await handleHiggsfieldAdapter(adapterRequest("{}"), {
      requireActiveOAuthSession: async () => null,
      logDiagnostic: (line) => diagnostics.push(line),
    });
    const body = await expectSafeJson(response, 401);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "oauth_required", data: { reconnectRequired: true } },
    });
    expect(body[HDEX_ADAPTER_BODY_SENTINEL_KEY]).toBe(HDEX_ADAPTER_BODY_SENTINEL_VALUE);
    expect(diagnostics.map((line) => JSON.parse(line))).toEqual([
      {
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: null,
        status: 401,
        errorCode: "oauth_required",
      },
    ]);
  });

  test("returns generation disabled as JSON before invoking a provider", async () => {
    const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession.session);
    const now = Date.now();
    const record = soulCapabilityRecord(now);
    await inspectHiggsfieldCapabilities({
      sessionFingerprint: fingerprint,
      mcpUrl: activeSession.config.mcpUrl,
      accessToken: activeSession.session.accessToken,
      now,
      runner: async () => record,
    });
    const previousGenerationEnabled = process.env.HDEX_GENERATION_ENABLED;
    process.env.HDEX_GENERATION_ENABLED = "false";
    const diagnostics: string[] = [];
    try {
      const response = await handleHiggsfieldAdapter(
        adapterRequest(
          JSON.stringify({
            operation: "createJobs",
            data: {
              jobSetType: "text2image_soul_v2",
              params: {
                prompt: "not transmitted",
                batch_size: 1,
                aspect_ratio: "1:1",
                quality: "1080p",
                medias: [],
              },
              confirmationToken: "request-disabled-test",
            },
          }),
        ),
        {
          requireActiveOAuthSession: async () => activeSession,
          logDiagnostic: (line) => diagnostics.push(line),
        },
      );
      const body = await expectSafeJson(response, 503);
      expect(body).toMatchObject({
        ok: false,
        error: { code: "generation_disabled", status: 503 },
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("not transmitted");
      expect(serialized).not.toContain(activeSession.session.accessToken);
      expect(serialized).not.toContain(activeSession.session.refreshToken);
      expect(diagnostics).toHaveLength(1);
      expect(JSON.parse(diagnostics[0]!)).toEqual({
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: "createJobs",
        status: 503,
        errorCode: "generation_disabled",
      });
      expect(diagnostics[0]).not.toContain("not transmitted");
      expect(diagnostics[0]).not.toContain(activeSession.session.accessToken);
      expect(diagnostics[0]).not.toContain(activeSession.session.refreshToken);
      expect(diagnostics[0]).not.toContain("request-disabled-test");
    } finally {
      clearHiggsfieldRuntime(fingerprint);
      if (previousGenerationEnabled === undefined) {
        delete process.env.HDEX_GENERATION_ENABLED;
      } else {
        process.env.HDEX_GENERATION_ENABLED = previousGenerationEnabled;
      }
    }
  });

  test("marks an outcome-unknown create response and logs only bounded generation diagnostics", async () => {
    const fingerprint = higgsfieldOAuthSessionFingerprint(activeSession.session);
    const now = Date.now();
    await inspectHiggsfieldCapabilities({
      sessionFingerprint: fingerprint,
      mcpUrl: activeSession.config.mcpUrl,
      accessToken: activeSession.session.accessToken,
      now,
      runner: async () => soulCapabilityRecord(now),
    });
    const diagnostics: string[] = [];
    try {
      const response = await handleHiggsfieldAdapter(
        adapterRequest(
          JSON.stringify({
            operation: "createJobs",
            data: {
              jobSetType: "text2image_soul_v2",
              params: {
                prompt: "private prompt",
                batch_size: 1,
                aspect_ratio: "1:1",
                quality: "1080p",
                medias: [],
              },
              confirmationToken: "private-request-id",
            },
          }),
        ),
        {
          requireActiveOAuthSession: async () => activeSession,
          logDiagnostic: (line) => diagnostics.push(line),
          createGeneration: async (input) => {
            input.onGenerationDiagnostic?.({
              generationStage: "generate_image",
              providerErrorPresent: false,
              toolErrorPresent: true,
              resultCount: 0,
              jobIdPresent: false,
              requestDurationMs: 24_500,
              responseShape: "plain_text_error",
              rejectionClass: "validation",
              parseFailure: "none",
              modelLineage: "conflict",
            });
            throw new ApiJobError(
              "outcome_unknown",
              "Higgsfield 생성 접수 결과를 확인할 수 없습니다.",
              { status: 502 },
            );
          },
        },
      );
      const body = await expectSafeJson(response, 502);
      expect(body).toMatchObject({
        ok: false,
        error: { code: "outcome_unknown", status: 502 },
      });
      expect(JSON.stringify(body)).not.toContain("generationStage");
      expect(JSON.stringify(body)).not.toContain("requestDurationMs");
      expect(diagnostics).toHaveLength(1);
      expect(JSON.parse(diagnostics[0]!)).toEqual({
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: "createJobs",
        status: 502,
        errorCode: "outcome_unknown",
        generationStage: "generate_image",
        providerErrorPresent: false,
        toolErrorPresent: true,
        resultCount: 0,
        jobIdPresent: false,
        requestDurationMs: 24_500,
        responseShape: "plain_text_error",
        rejectionClass: "validation",
        parseFailure: "none",
        modelLineage: "conflict",
      });
      expect(diagnostics[0]).not.toContain("private prompt");
      expect(diagnostics[0]).not.toContain("private-request-id");
      expect(diagnostics[0]).not.toContain(activeSession.session.accessToken);
    } finally {
      clearHiggsfieldRuntime(fingerprint);
    }
  });

  test("normalizes malformed JSON and unexpected route errors without leaking details", async () => {
    const diagnostics: string[] = [];
    const malformed = await handleHiggsfieldAdapter(adapterRequest("{"), {
      requireActiveOAuthSession: async () => activeSession,
      logDiagnostic: (line) => diagnostics.push(line),
    });
    expect(await expectSafeJson(malformed, 400)).toMatchObject({
      ok: false,
      error: { code: "validation", status: 400 },
    });

    const unexpected = await handleHiggsfieldAdapter(adapterRequest("{}"), {
      requireActiveOAuthSession: async () => {
        throw new Error(
          "private-token private-cookie https://internal.example/path?code=private-query",
        );
      },
      logDiagnostic: (line) => diagnostics.push(line),
    });
    const serialized = JSON.stringify(await expectSafeJson(unexpected, 500));
    expect(serialized).toContain('"code":"unexpected"');
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("private-cookie");
    expect(serialized).not.toContain("private-query");
    expect(serialized).not.toContain("internal.example");
    expect(diagnostics.map((line) => JSON.parse(line))).toEqual([
      {
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: null,
        status: 400,
        errorCode: "validation",
      },
      {
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: null,
        status: 500,
        errorCode: "unexpected",
      },
    ]);
    expect(diagnostics.join("\n")).not.toContain("private-token");
    expect(diagnostics.join("\n")).not.toContain("private-cookie");
    expect(diagnostics.join("\n")).not.toContain("private-query");
  });
});

describe("Node catastrophic error response boundary", () => {
  test("marks final non-redirect API responses but leaves OAuth redirects unchanged", () => {
    const api = finalizeNodeResponse(
      new Request(`${PUBLIC_ORIGIN}/api/higgsfield/adapter`),
      Response.json(
        { ok: false, error: { code: "outcome_unknown" } },
        { status: 502 },
      ),
    );
    expect(api.status).toBe(502);
    expect(api.headers.get("x-hdex-api-response")).toBe("1");

    for (const path of [
      "/api/higgsfield/oauth/connect",
      "/api/higgsfield/oauth/callback?code=private-query",
    ]) {
      const redirect = finalizeNodeResponse(
        new Request(`${PUBLIC_ORIGIN}${path}`),
        new Response(null, {
          status: 302,
          headers: { location: `${PUBLIC_ORIGIN}/` },
        }),
      );
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/`);
      expect(redirect.headers.get("x-hdex-api-response")).toBeNull();
    }
  });

  test("returns API failures as JSON while preserving page failures as HTML", async () => {
    const originalError = console.error;
    const logs: unknown[] = [];
    console.error = (...values) => logs.push(...values);
    try {
      const swallowed = () =>
        Response.json(
          { unhandled: true, message: "HTTPError", private: "private-response-body" },
          { status: 500 },
        );
      const api = await normalizeCatastrophicResponse(
        new Request(`${PUBLIC_ORIGIN}/api/higgsfield/adapter?token=private-query`),
        swallowed(),
      );
      const apiBody = JSON.stringify(await expectSafeJson(api, 500));
      expect(apiBody).toContain('"code":"unexpected"');
      expect(apiBody).not.toContain("private-response-body");
      expect(apiBody).not.toContain("private-query");
      expect(logs).toEqual(["api_request_failed"]);

      for (const path of [
        "/api/higgsfield/oauth/connect",
        "/api/higgsfield/oauth/callback?code=private-query",
      ]) {
        const redirect = new Response(null, {
          status: 302,
          headers: { location: `${PUBLIC_ORIGIN}/` },
        });
        expect(
          await normalizeCatastrophicResponse(new Request(`${PUBLIC_ORIGIN}${path}`), redirect),
        ).toBe(redirect);
      }

      logs.length = 0;
      const htmlApiResponse = new Response(
        "<!doctype html><p>private-token private-cookie</p>",
        { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
      );
      const htmlApi = await normalizeCatastrophicResponse(
        new Request(`${PUBLIC_ORIGIN}/api/higgsfield/adapter?token=private-query`),
        htmlApiResponse,
      );
      const htmlApiBody = JSON.stringify(await expectSafeJson(htmlApi, 500));
      expect(htmlApiBody).toContain('"code":"unexpected"');
      expect(htmlApiBody).not.toContain("private-token");
      expect(htmlApiBody).not.toContain("private-cookie");
      expect(htmlApiBody).not.toContain("private-query");
      expect(htmlApiResponse.bodyUsed).toBe(false);
      expect(logs).toEqual(["api_request_failed"]);

      logs.length = 0;
      const page = await normalizeCatastrophicResponse(
        new Request(`${PUBLIC_ORIGIN}/presets`),
        Response.json({ unhandled: true, message: "HTTPError" }, { status: 500 }),
      );
      expect(page.status).toBe(500);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("<!doctype html>");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBeInstanceOf(Error);
    } finally {
      console.error = originalError;
    }
  });
});
