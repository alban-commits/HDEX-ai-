import { ApiJobError } from "@higgsfield/fnf/errors";
import {
  createHiggsfieldGeneration,
  getHiggsfieldGeneration,
  listHiggsfieldGenerations,
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

const MAX_JSON_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readInput(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_JSON_BYTES) {
    throw new ApiJobError("request_too_large", "요청 크기 제한을 초과했습니다.", { status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
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
};

export async function handleHiggsfieldAdapter(
  request: Request,
  options: AdapterRouteOptions = {},
): Promise<Response> {
  const headers = new Headers(NO_STORE_HEADERS);
  let fingerprint: string | undefined;
  try {
    const active = await (options.requireActiveOAuthSession ?? requireActiveOAuthSession)(request);
    if (!active) {
      clearAllOAuthCookies(headers);
      return jsonNoStore(
        {
          ok: false,
          error: {
            code: "oauth_required",
            message: "내 Higgsfield 계정을 연결해 주세요.",
            data: { reconnectRequired: true },
          },
        },
        { status: 401, headers },
      );
    }
    const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
    if (crossSite) {
      return jsonNoStore(
        {
          ok: false,
          error: {
            code: "invalid_origin",
            message: "요청 출처를 확인할 수 없습니다.",
            status: crossSite.status,
          },
        },
        { status: crossSite.status, headers },
      );
    }
    if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
    fingerprint = higgsfieldOAuthSessionFingerprint(active.session);
    const input = await readInput(request);
    const operation = input.operation;
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
        value = await createHiggsfieldGeneration({
          fingerprint,
          session: active.session,
          jobSetType: data.jobSetType,
          params: data.params,
          confirmationToken: data.confirmationToken,
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
    return jsonNoStore({ ok: true, value }, { headers });
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
      return jsonNoStore(
        {
          ok: false,
          error: {
            code: "oauth_required",
            message: "Higgsfield 계정을 다시 연결해 주세요.",
            status: 401,
            data: { reconnectRequired: true },
          },
        },
        { status: 401, headers },
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
    return jsonNoStore(
      { ok: false, error: payload },
      { status: payload.status ?? 500, headers },
    );
  }
}
