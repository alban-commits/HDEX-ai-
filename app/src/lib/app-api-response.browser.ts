import { errorFromJSON } from "@higgsfield/fnf/errors";
import {
  HDEX_ADAPTER_BODY_SENTINEL_KEY,
  HDEX_ADAPTER_BODY_SENTINEL_VALUE,
  HDEX_ADAPTER_MAX_JSON_BYTES,
} from "./app-api-contract";

const APP_RESPONSE_HEADER = "X-HDEX-API-Response";

type SafeFailureStage =
  | "request_failed"
  | "access_redirect"
  | "app_header_missing"
  | "content_type_invalid"
  | "json_parse_failed"
  | "envelope_contract_invalid";

type SafeResponseDiagnostics = {
  httpStatus: number;
  contentTypePresent: boolean;
  contentType: string | null;
  appResponseHeaderMatches: boolean;
  failureStage: SafeFailureStage;
};

function normalizedContentType(response: Response): {
  present: boolean;
  value: string | null;
} {
  const raw = response.headers.get("content-type");
  if (raw === null) return { present: false, value: null };
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return {
    present: true,
    value: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
      ? mediaType.slice(0, 100)
      : "invalid",
  };
}

const INVALID_BOUNDED_JSON = Symbol("invalid_bounded_json");

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > HDEX_ADAPTER_MAX_JSON_BYTES)
  ) {
    return INVALID_BOUNDED_JSON;
  }
  if (!response.body) return INVALID_BOUNDED_JSON;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > HDEX_ADAPTER_MAX_JSON_BYTES) {
        await reader.cancel();
        return INVALID_BOUNDED_JSON;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return INVALID_BOUNDED_JSON;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return INVALID_BOUNDED_JSON;
  }
}

function hasAdapterBodySentinel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[HDEX_ADAPTER_BODY_SENTINEL_KEY] ===
      HDEX_ADAPTER_BODY_SENTINEL_VALUE
  );
}

function throwSafeResponseError(input: {
  code:
    | "adapter_request_failed"
    | "access_session_required"
    | "adapter_non_app_response"
    | "adapter_invalid_json_response"
    | "adapter_response_contract_invalid";
  message: string;
  response?: Response;
  stage: SafeFailureStage;
}): never {
  const contentType = input.response
    ? normalizedContentType(input.response)
    : { present: false, value: null };
  const diagnostics: SafeResponseDiagnostics = {
    httpStatus: input.response?.status ?? 0,
    contentTypePresent: contentType.present,
    contentType: contentType.value,
    appResponseHeaderMatches:
      input.response?.headers.get(APP_RESPONSE_HEADER) === "1",
    failureStage: input.stage,
  };
  throw errorFromJSON({
    code: input.code,
    message: input.message,
    ...(input.response?.status ? { status: input.response.status } : {}),
    data: diagnostics,
  });
}

export async function fetchAppJson<T>(input: {
  path: string;
  init: RequestInit;
  isEnvelope: (value: unknown, status: number) => value is T;
  allowHeaderlessAdapterError?: boolean;
}): Promise<T> {
  const headers = new Headers(input.init.headers);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(input.path, {
      ...input.init,
      headers,
      redirect: "manual",
    });
  } catch {
    throwSafeResponseError({
      code: "adapter_request_failed",
      message: "서버 연결 요청을 완료하지 못했습니다.",
      stage: "request_failed",
    });
  }
  if (
    response.status === 0 ||
    response.type === "opaqueredirect" ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    throwSafeResponseError({
      code: "access_session_required",
      message: "사내 접근 세션을 확인해 주세요.",
      response,
      stage: "access_redirect",
    });
  }
  const appHeaderMatches = response.headers.get(APP_RESPONSE_HEADER) === "1";
  const contentTypeIsJson = normalizedContentType(response).value === "application/json";
  if (!appHeaderMatches) {
    if (
      input.allowHeaderlessAdapterError &&
      response.status >= 400 &&
      response.status < 600 &&
      contentTypeIsJson
    ) {
      const fallbackValue = await readBoundedJson(response);
      if (
        fallbackValue !== INVALID_BOUNDED_JSON &&
        hasAdapterBodySentinel(fallbackValue) &&
        input.isEnvelope(fallbackValue, response.status)
      ) {
        return fallbackValue;
      }
    }
    throwSafeResponseError({
      code: "adapter_non_app_response",
      message: "앱 서버 응답을 확인할 수 없습니다.",
      response,
      stage: "app_header_missing",
    });
  }
  if (!contentTypeIsJson) {
    throwSafeResponseError({
      code: "adapter_invalid_json_response",
      message: "서버 API 응답을 확인하지 못했습니다.",
      response,
      stage: "content_type_invalid",
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throwSafeResponseError({
      code: "adapter_invalid_json_response",
      message: "서버 API 응답을 확인하지 못했습니다.",
      response,
      stage: "json_parse_failed",
    });
  }
  if (!input.isEnvelope(value, response.status)) {
    throwSafeResponseError({
      code: "adapter_response_contract_invalid",
      message: "서버 API 응답 계약이 올바르지 않습니다.",
      response,
      stage: "envelope_contract_invalid",
    });
  }
  return value;
}
