import { describe, expect, test } from "bun:test";
import { handleHiggsfieldCapabilityInspection } from "../src/server/higgsfield-capability-route.server";
import { HiggsfieldMcpError } from "../src/server/higgsfield-mcp.server";
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
    accessToken: "private-capability-access-token",
    refreshToken: "private-capability-refresh-token",
    clientId: "private-capability-client-id",
    tokenEndpoint: "https://auth.higgsfield.ai/token",
    resource: "https://mcp.higgsfield.ai/mcp",
    accessExpiresAt: Date.now() + 60_000,
    sessionExpiresAt: Date.now() + 120_000,
  },
};

function request(origin = PUBLIC_ORIGIN): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/capabilities`, {
    method: "POST",
    headers: { origin },
  });
}

async function safeJson(response: Response, status: number): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-hdex-api-response")).toBe("1");
  return response.json() as Promise<Record<string, unknown>>;
}

function parsedLogs(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["event", "reason", "stage", "status"]);
    expect(line).not.toContain("private-capability");
    expect(line).not.toContain("mcp.higgsfield.ai");
    expect(line).not.toContain("auth.higgsfield.ai");
    return parsed;
  });
}

describe("Higgsfield capability JSON boundary", () => {
  test("converts a session-stage exception to one safe JSON 424 response", async () => {
    const logs: string[] = [];
    const response = await handleHiggsfieldCapabilityInspection(request(), {
      requireSession: async () => {
        throw new Error(
          "private-capability-access-token https://private.example/path?token=secret",
        );
      },
      logDiagnostic: (line) => logs.push(line),
    });
    expect(await safeJson(response, 424)).toEqual({
      ok: false,
      reason: "provider_failure",
    });
    expect(parsedLogs(logs)).toEqual([
      {
        event: "higgsfield_capability_response",
        stage: "session",
        status: 424,
        reason: "provider_failure",
      },
    ]);
  });

  test("returns dependency failures as JSON 424 without retrying inspection", async () => {
    for (const reason of ["invalid_response", "provider_failure"] as const) {
      const logs: string[] = [];
      let inspections = 0;
      const response = await handleHiggsfieldCapabilityInspection(request(), {
        requireSession: async () => activeSession,
        inspectCapabilities: async () => {
          inspections += 1;
          throw new HiggsfieldMcpError(reason);
        },
        logDiagnostic: (line) => logs.push(line),
      });
      expect(await safeJson(response, 424)).toEqual({ ok: false, reason });
      expect(inspections).toBe(1);
      expect(parsedLogs(logs)).toEqual([
        {
          event: "higgsfield_capability_response",
          stage: "inspection",
          status: 424,
          reason,
        },
      ]);
    }
  });

  test("keeps missing and failed authentication as JSON 401", async () => {
    const missingLogs: string[] = [];
    const missing = await handleHiggsfieldCapabilityInspection(request(), {
      requireSession: async () => null,
      logDiagnostic: (line) => missingLogs.push(line),
    });
    expect(await safeJson(missing, 401)).toMatchObject({
      ok: false,
      reason: "oauth_required",
      reconnectRequired: true,
    });
    expect(parsedLogs(missingLogs)[0]).toMatchObject({ stage: "session", status: 401 });

    let invalidations = 0;
    const failed = await handleHiggsfieldCapabilityInspection(request(), {
      requireSession: async () => activeSession,
      inspectCapabilities: async () => {
        throw new HiggsfieldMcpError("authentication_failed");
      },
      invalidateAuthentication: async () => {
        invalidations += 1;
      },
      logDiagnostic: () => undefined,
    });
    expect(await safeJson(failed, 401)).toMatchObject({
      ok: false,
      reason: "oauth_required",
      reconnectRequired: true,
    });
    expect(invalidations).toBe(1);
  });

  test("returns one ready capability summary as JSON 200 without generation calls", async () => {
    const logs: string[] = [];
    let inspections = 0;
    const capability = {
      status: "ready",
      models: [
        { key: "soul_2", name: "Soul 2", ready: true },
        { key: "gpt_image_2", name: "GPT Image 2", ready: true },
      ],
    };
    const response = await handleHiggsfieldCapabilityInspection(request(), {
      requireSession: async () => activeSession,
      inspectCapabilities: async () => {
        inspections += 1;
        return {
          checkedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          toolCount: 5,
          pageCount: 1,
          tools: [],
          models: [],
        };
      },
      capabilitySummary: () => capability,
      logDiagnostic: (line) => logs.push(line),
    });
    expect(await safeJson(response, 200)).toEqual({ ok: true, capability });
    expect(inspections).toBe(1);
    expect(parsedLogs(logs)).toEqual([
      {
        event: "higgsfield_capability_response",
        stage: "response",
        status: 200,
        reason: "ok",
      },
    ]);
  });

  test("converts a summary-stage exception to one safe JSON 424 response", async () => {
    const logs: string[] = [];
    const response = await handleHiggsfieldCapabilityInspection(request(), {
      requireSession: async () => activeSession,
      inspectCapabilities: async () => ({
        checkedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        toolCount: 5,
        pageCount: 1,
        tools: [],
        models: [],
      }),
      capabilitySummary: () => {
        throw new Error("private-capability-summary https://private.example/model");
      },
      logDiagnostic: (line) => logs.push(line),
    });
    expect(await safeJson(response, 424)).toEqual({
      ok: false,
      reason: "provider_failure",
    });
    expect(parsedLogs(logs)).toEqual([
      {
        event: "higgsfield_capability_response",
        stage: "response",
        status: 424,
        reason: "provider_failure",
      },
    ]);
  });

  test("keeps cross-site rejection as one JSON 403 response", async () => {
    const logs: string[] = [];
    const response = await handleHiggsfieldCapabilityInspection(
      request("https://attacker.example"),
      {
        requireSession: async () => activeSession,
        logDiagnostic: (line) => logs.push(line),
      },
    );
    expect(await safeJson(response, 403)).toEqual({ error: "invalid_origin" });
    expect(parsedLogs(logs)).toEqual([
      {
        event: "higgsfield_capability_response",
        stage: "origin",
        status: 403,
        reason: "invalid_origin",
      },
    ]);
  });
});
