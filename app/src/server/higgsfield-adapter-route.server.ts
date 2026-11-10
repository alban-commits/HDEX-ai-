import { ApiJobError } from "@higgsfield/fnf/errors";
import {
  HDEX_ADAPTER_BODY_SENTINEL_KEY,
  HDEX_ADAPTER_BODY_SENTINEL_VALUE,
  HDEX_ADAPTER_MAX_JSON_BYTES,
} from "../lib/app-api-contract";
import {
  createHiggsfieldGeneration,
  getHiggsfieldGeneration,
  listHiggsfieldGenerations,
  type HiggsfieldGenerationDiagnostic,
} from "./higgsfield-generation-adapter.server";
import { higgsfieldOAuthSessionFingerprint } from "./higgsfield-oauth.server";
import {
  getHiggsfieldCapabilityRecord,
  HiggsfieldMcpError,
  inspectHiggsfieldCapabilities,
} from "./higgsfield-mcp.server";
import {
  appendOAuthSessionCookies,
  clearAllOAuthCookies,
  requireActiveOAuthSession,
  type ActiveOAuthSession,
} from "./oauth-routes.server";
import { jsonNoStore, NO_STORE_HEADERS, rejectCrossSiteMutation } from "./http.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "./higgsfield-reconnect.server";

const ADAPTER_OPERATIONS = new Set([
  "createJobs",
  "getJob",
  "listJobs",
  "estimateCost",
  "getUser",
  "listWorkspaces",
  "getCurrentWorkspace",
  "getWorkspaceWallet",
  "switchWorkspace",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readInput(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > HDEX_ADAPTER_MAX_JSON_BYTES) {
    throw new ApiJobError("request_too_large", "요청 크기 제한을 초과했습니다.", { status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > HDEX_ADAPTER_MAX_JSON_BYTES) {
    throw new ApiJobError("request_too_large", "요청 크기 제한을 초과했습니다.", { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApiJobError("validation", "요청 JSON 형식이 올바르지 않습니다.", {
      status: 400,
    });
  }
  if (!isRecord(parsed)) {
    throw new ApiJobError("validation", "요청 형식이 올바르지 않습니다.", { status: 400 });
  }
  return parsed;
}

type AdapterRouteOptions = {
  requireActiveOAuthSession?: (request: Request) => Promise<ActiveOAuthSession | null>;
  logDiagnostic?: (line: string) => void;
  createGeneration?: typeof createHiggsfieldGeneration;
};

export async function handleHiggsfieldAdapter(
  request: Request,
  options: AdapterRouteOptions = {},
): Promise<Response> {
  const headers = new Headers(NO_STORE_HEADERS);
  let fingerprint: string | undefined;
  let operationName: string | null = null;
  let generationDiagnostic: HiggsfieldGenerationDiagnostic | undefined;
  const respond = (value: unknown, status: number, errorCode: string): Response => {
    const safeErrorCode = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : "unexpected";
    (options.logDiagnostic ?? console.info)(
      JSON.stringify({
        event: "higgsfield_adapter_response",
        routeReached: true,
        operation: operationName,
        status,
        errorCode: safeErrorCode,
        ...(generationDiagnostic ?? {}),
      }),
    );
    const body = isRecord(value)
      ? {
          ...value,
          [HDEX_ADAPTER_BODY_SENTINEL_KEY]: HDEX_ADAPTER_BODY_SENTINEL_VALUE,
        }
      : value;
    return jsonNoStore(body, { status, headers });
  };
  try {
    const active = await (options.requireActiveOAuthSession ?? requireActiveOAuthSession)(request);
    if (!active) {
      clearAllOAuthCookies(headers);
      return respond(
        {
          ok: false,
          error: {
            code: "oauth_required",
            message: "내 Higgsfield 계정을 연결해 주세요.",
            data: { reconnectRequired: true },
          },
        },
        401,
        "oauth_required",
      );
    }
    const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
    if (crossSite) {
      return respond(
        {
          ok: false,
          error: {
            code: "invalid_origin",
            message: "요청 출처를 확인할 수 없습니다.",
            status: crossSite.status,
          },
        },
        crossSite.status,
        "invalid_origin",
      );
    }
    if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
    fingerprint = higgsfieldOAuthSessionFingerprint(active.session);
    const input = await readInput(request);
    const operation = input.operation;
    operationName =
      typeof operation === "string" && ADAPTER_OPERATIONS.has(operation) ? operation : null;
    const data = isRecord(input.data) ? input.data : {};
    let value: unknown;
    switch (operation) {
      case "createJobs":
        if (
          typeof data.jobSetType !== "string" ||
          !isRecord(data.params) ||
          typeof data.confirmationToken !== "string"
        ) {
          throw new ApiJobError("validation", "생성 요청 형식이 올바르지 않습니다.", {
            status: 400,
          });
        }
        if (!getHiggsfieldCapabilityRecord(fingerprint)) {
          await inspectHiggsfieldCapabilities({
            sessionFingerprint: fingerprint,
            mcpUrl: active.config.mcpUrl,
            accessToken: active.session.accessToken,
          });
        }
        value = await (options.createGeneration ?? createHiggsfieldGeneration)({
          fingerprint,
          session: active.session,
          jobSetType: data.jobSetType,
          params: data.params,
          confirmationToken: data.confirmationToken,
          onGenerationDiagnostic: (diagnostic) => {
            generationDiagnostic = {
              generationStage: "generate_image",
              providerErrorPresent: diagnostic.providerErrorPresent === true,
              toolErrorPresent: diagnostic.toolErrorPresent === true,
              resultCount: Math.min(Math.max(Math.trunc(diagnostic.resultCount), 0), 10_000),
              jobIdPresent: diagnostic.jobIdPresent === true,
              requestDurationMs: Math.min(
                Math.max(Math.trunc(diagnostic.requestDurationMs), 0),
                300_000,
              ),
              responseShape: [
                "structured",
                "json_text",
                "plain_text_error",
                "direct",
                "invalid",
              ].includes(diagnostic.responseShape)
                ? diagnostic.responseShape
                : "invalid",
              rejectionClass: [
                "credits",
                "validation",
                "permission",
                "moderation",
                "unknown",
              ].includes(diagnostic.rejectionClass)
                ? diagnostic.rejectionClass
                : "unknown",
              parseFailure: [
                "none",
                "malformed",
                "oversized",
                "ambiguous",
                "missing",
              ].includes(diagnostic.parseFailure)
                ? diagnostic.parseFailure
                : "missing",
              modelLineage: [
                "provider_model",
                "public_job_type",
                "omitted",
                "conflict",
              ].includes(diagnostic.modelLineage)
                ? diagnostic.modelLineage
                : "conflict",
            };
          },
        });
        break;
      case "getJob":
        if (typeof data.id !== "string") {
          throw new ApiJobError("validation", "작업 ID가 필요합니다.", { status: 400 });
        }
        value = await getHiggsfieldGeneration({
          fingerprint,
          session: active.session,
          jobId: data.id,
        });
        break;
      case "listJobs":
        value = await listHiggsfieldGenerations({
          fingerprint,
          size: typeof data.size === "number" ? data.size : undefined,
        });
        break;
      case "estimateCost":
        throw new ApiJobError(
          "not_supported",
          "비용 표시는 기존 모델의 로컬 계산 결과를 사용합니다.",
          { status: 405 },
        );
      case "getUser":
        value = { id: "higgsfield-oauth", workspace_id: "personal" };
        break;
      case "listWorkspaces":
        value = { items: [{ id: "personal", name: "Personal" }] };
        break;
      case "getCurrentWorkspace":
        value = { id: "personal", name: "Personal" };
        break;
      case "getWorkspaceWallet":
        value = null;
        break;
      case "switchWorkspace":
        value = { id: "personal", name: "Personal" };
        break;
      default:
        throw new ApiJobError("not_supported", "지원되지 않는 adapter 작업입니다.", {
          status: 405,
        });
    }
    return respond({ ok: true, value }, 200, "ok");
  } catch (error) {
    if (isHiggsfieldAuthenticationFailure(error)) {
      if (fingerprint) {
        try {
          await invalidateHiggsfieldAuthentication({ headers, sessionFingerprint: fingerprint });
        } catch {
          clearAllOAuthCookies(headers);
        }
      } else {
        clearAllOAuthCookies(headers);
      }
      return respond(
        {
          ok: false,
          error: {
            code: "oauth_required",
            message: "Higgsfield 계정을 다시 연결해 주세요.",
            status: 401,
            data: { reconnectRequired: true },
          },
        },
        401,
        "oauth_required",
      );
    }
    const payload =
      error instanceof ApiJobError
        ? error.toJSON()
        : error instanceof HiggsfieldMcpError
          ? {
              code: error.reason,
              message: "Higgsfield 모델 연결 상태를 확인하지 못했습니다.",
              status: 502,
            }
          : { code: "unexpected", message: "서버 연결 요청을 처리하지 못했습니다." };
    const status = payload.status ?? 500;
    return respond(
      { ok: false, error: payload },
      status,
      payload.code,
    );
  }
}
