import { ApiJobError } from "@higgsfield/fnf/errors";
import {
  callHiggsfieldMcpTool,
  classifyHiggsfieldProviderRejection,
  getHiggsfieldCapabilityRecord,
  HiggsfieldMcpContentError,
  HiggsfieldMcpError,
  parseHiggsfieldMcpContent,
  requireDiscoveredModel,
  type DiscoveredModelProfile,
  type HiggsfieldMcpParseFailure,
  type HiggsfieldMcpRejectionClass,
  type HiggsfieldMcpResponseShape,
} from "./higgsfield-mcp.server";
import type { HiggsfieldOAuthSession } from "./higgsfield-oauth.server";
import {
  claimGenerationAttempt,
  clearGenerationStore,
  finishGenerationAttempt,
  generationRequestHash,
  getGenerationJob,
  hasGenerationMedia,
  listGenerationJobs,
  putGenerationJobs,
  recordObservedProviderJobIds,
  type StoredGenerationJob,
} from "./generation-attempt-store.server";
import { getTemporaryStorageConfig, isGenerationEnabled } from "./runtime-config.server";

type FnfJob = {
  id: string;
  job_set_type: "text2image_soul_v2" | "gpt_image_2";
  status: "queued" | "in_progress" | "completed" | "failed" | "canceled";
  result_url?: string;
  params?: Record<string, unknown>;
  created_at: number;
  fail_reason?: string;
};

type ToolInvoker = (
  name: "generate_image" | "job_status",
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type HiggsfieldGenerationDiagnostic = {
  generationStage: "generate_image";
  providerErrorPresent: boolean;
  toolErrorPresent: boolean;
  resultCount: number;
  jobIdPresent: boolean;
  requestDurationMs: number;
  responseShape: HiggsfieldMcpResponseShape;
  rejectionClass: HiggsfieldMcpRejectionClass;
  parseFailure: HiggsfieldMcpParseFailure;
  modelLineage: "provider_model" | "public_job_type" | "omitted" | "conflict";
};

type GenerationFlightOutcome = {
  jobs: StoredGenerationJob[];
  observedProviderJobIds: string[];
  error?: unknown;
};
const generationFlights = new Map<string, Promise<GenerationFlightOutcome>>();
const generationEpochs = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,240}$/.test(value) ? value : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function structuredGenerationContent(value: unknown): {
  content: Record<string, unknown>;
  toolError: boolean;
  responseShape: Exclude<HiggsfieldMcpResponseShape, "invalid">;
  rejectionClass: HiggsfieldMcpRejectionClass;
} {
  const parsed = parseHiggsfieldMcpContent(value);
  return {
    content: parsed.content,
    toolError: parsed.isError,
    responseShape: parsed.responseShape,
    rejectionClass: parsed.rejectionClass,
  };
}

function responseRequestId(content: Record<string, unknown>): string | null {
  return safeId(content.request_id);
}

function providerError(content: Record<string, unknown>): string | null {
  return typeof content.error === "string" && content.error.length > 0 ? content.error : null;
}

function explicitProviderFailure(error: string): ApiJobError {
  return classifyHiggsfieldProviderRejection(error) === "credits"
    ? new ApiJobError(
        "insufficient_credits",
        "Higgsfield 개인 계정 크레딧을 확인해 주세요.",
        { status: 402 },
      )
    : new ApiJobError(
        "provider_failure",
        "Higgsfield 이미지 생성 요청이 거부되었습니다.",
        { status: 502 },
      );
}

function toolProviderFailure(rejectionClass: HiggsfieldMcpRejectionClass): ApiJobError {
  return rejectionClass === "credits"
    ? new ApiJobError(
        "insufficient_credits",
        "Higgsfield 개인 계정 크레딧을 확인해 주세요.",
        { status: 402 },
      )
    : new ApiJobError(
        "provider_failure",
        "Higgsfield 이미지 생성 요청이 거부되었습니다.",
        { status: 502 },
      );
}

function normalizeGenerateError(error: unknown): unknown {
  if (error instanceof ApiJobError) return error;
  if (
    error instanceof HiggsfieldMcpError &&
    ["authentication_failed", "rate_limited", "provider_failure"].includes(error.reason)
  ) {
    return error;
  }
  return new ApiJobError(
    "outcome_unknown",
    "Higgsfield 생성 접수 결과를 확인할 수 없습니다. 자동 재시도하지 않았습니다.",
    { status: 502 },
  );
}

function providerStatus(value: unknown): FnfJob["status"] | null {
  switch (value) {
    case "pending":
    case "waiting":
    case "queued":
      return "queued";
    case "in_progress":
    case "ip_detect":
      return "in_progress";
    case "completed":
      return "completed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "failed":
    case "nsfw":
    case "ip_detected":
      return "failed";
    default:
      return null;
  }
}

function publicResultUrl(jobId: string): string {
  return `/api/higgsfield/result/${encodeURIComponent(jobId)}`;
}

function clientJob(job: StoredGenerationJob): FnfJob {
  return {
    id: job.id,
    job_set_type: job.jobSetType,
    status: job.status,
    ...(job.status === "completed" ? { result_url: publicResultUrl(job.id) } : {}),
    params: job.params,
    created_at: job.createdAt,
    ...(job.failReason ? { fail_reason: job.failReason } : {}),
  };
}

function extractMediaIds(params: Record<string, unknown>): string[] {
  if (!Array.isArray(params.medias)) return [];
  const ids = params.medias.flatMap((item) => {
    if (!isRecord(item)) return [];
    const direct = safeId(item.id ?? item.value ?? item.media_id);
    if (direct) return [direct];
    if (isRecord(item.media)) {
      const nested = safeId(item.media.id ?? item.media.value);
      if (nested) return [nested];
    }
    return [];
  });
  if (ids.length !== params.medias.length || new Set(ids).size !== ids.length) {
    throw new ApiJobError("invalid_media", "업로드한 이미지 참조를 확인할 수 없습니다.", {
      status: 400,
    });
  }
  return ids;
}

function exactProfileOption(
  profile: DiscoveredModelProfile,
  parameter: string | undefined,
  requested: string,
): string | number | boolean | null {
  if (!parameter) return null;
  const options = profile.parameterOptions?.[parameter];
  if (!options) return requested;
  return options.find((option) => String(option).toLowerCase() === requested.toLowerCase()) ?? null;
}

function supportsAdvertisedAspect(profile: DiscoveredModelProfile, requested: string): boolean {
  return (profile.aspectRatios ?? []).some(
    (value) => value.toLowerCase() === requested.toLowerCase(),
  );
}

function executionParams(input: {
  fingerprint: string;
  jobSetType: FnfJob["job_set_type"];
  params: Record<string, unknown>;
}): {
  profile: DiscoveredModelProfile & { available: true; modelId: string };
  params: Record<string, unknown>;
} {
  const modelKey = input.jobSetType === "text2image_soul_v2" ? "soul_2" : "gpt_image_2";
  const profile = requireDiscoveredModel(input.fingerprint, modelKey);
  const prompt = typeof input.params.prompt === "string" ? input.params.prompt.trim() : "";
  const count = Number(input.params.batch_size ?? 1);
  const aspectRatio =
    typeof input.params.aspect_ratio === "string" ? input.params.aspect_ratio : "";
  if (!prompt || !Number.isSafeInteger(count) || count < 1 || count > 4 || !aspectRatio) {
    throw new ApiJobError("validation", "생성 입력을 확인해 주세요.", { status: 400 });
  }

  const aspectValue = exactProfileOption(profile, profile.aspectRatioParameter, aspectRatio);
  if (
    !profile.aspectRatioParameter ||
    aspectValue === null ||
    !supportsAdvertisedAspect(profile, aspectRatio)
  ) {
    throw new ApiJobError(
      "model_contract_mismatch",
      "현재 Higgsfield 모델이 선택한 이미지 비율을 지원하지 않습니다.",
      { status: 409 },
    );
  }
  const providerParams: Record<string, unknown> = {
    model: profile.modelId,
    prompt,
    count,
    [profile.aspectRatioParameter]: aspectValue,
  };

  const uiResolutionValid =
    input.jobSetType === "text2image_soul_v2"
      ? input.params.quality === "1080p"
      : typeof input.params.resolution === "string" &&
        input.params.resolution.toLowerCase() === "2k";
  if (
    !uiResolutionValid ||
    !profile.resolutionParameter ||
    profile.resolutionValue === undefined ||
    profile.resolutionParameter === profile.aspectRatioParameter
  ) {
    throw new ApiJobError(
      "model_contract_mismatch",
      "현재 Higgsfield 모델이 선택한 해상도를 지원하지 않습니다.",
      { status: 409 },
    );
  }
  providerParams[profile.resolutionParameter] = profile.resolutionValue;

  if (input.jobSetType === "gpt_image_2") {
    const requestedQuality = typeof input.params.quality === "string" ? input.params.quality : "";
    if (
      requestedQuality.toLowerCase() !== "high" ||
      !profile.qualityParameter ||
      profile.qualityValue === undefined ||
      [profile.aspectRatioParameter, profile.resolutionParameter].includes(profile.qualityParameter)
    ) {
      throw new ApiJobError(
        "model_contract_mismatch",
        "현재 Higgsfield 모델이 선택한 품질을 지원하지 않습니다.",
        { status: 409 },
      );
    }
    providerParams[profile.qualityParameter] = profile.qualityValue;
  }

  const mediaIds = extractMediaIds(input.params);
  if (mediaIds.length > 0) {
    if (!profile.mediaRole || !profile.maximumImages || mediaIds.length > profile.maximumImages) {
      throw new ApiJobError(
        "model_contract_mismatch",
        "현재 Higgsfield 모델의 이미지 입력 계약과 일치하지 않습니다.",
        { status: 409 },
      );
    }
    providerParams.medias = mediaIds.map((value) => ({ role: profile.mediaRole, value }));
  } else {
    providerParams.medias = [];
  }
  return { profile, params: providerParams };
}

function storedWireParams(
  jobSetType: FnfJob["job_set_type"],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const aspectRatio = typeof params.aspect_ratio === "string" ? params.aspect_ratio : "";
  const batchSize = Number(params.batch_size ?? 1);
  const quality = typeof params.quality === "string" ? params.quality : undefined;
  const resolution = typeof params.resolution === "string" ? params.resolution : undefined;
  const mediaIds = extractMediaIds(params);
  return {
    prompt,
    aspect_ratio: aspectRatio,
    batch_size: batchSize,
    ...(quality ? { quality } : {}),
    ...(jobSetType === "gpt_image_2" && resolution ? { resolution } : {}),
    medias: mediaIds.map((id) => ({ id, type: "media_input" })),
  };
}

async function parseAndPersistCreatedJobs(
  content: Record<string, unknown>,
  expectedModelId: string,
  expectedCount: number,
  responseShape: HiggsfieldMcpResponseShape,
  persistence: {
    fingerprint: string;
    requestId: string;
    jobSetType: FnfJob["job_set_type"];
    params: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    now: number;
    expiresAt: number;
    isCurrent: () => boolean;
  },
): Promise<{
  jobs: StoredGenerationJob[];
  modelLineage: HiggsfieldGenerationDiagnostic["modelLineage"];
}> {
  const results = Array.isArray(content.results) ? content.results : [];
  const candidates: Array<{
    result: Record<string, unknown>;
    providerJobId: string;
  }> = [];
  const observed = new Set<string>();
  const occurrences = new Map<string, number>();
  let invalid = !Array.isArray(content.results) || results.length !== expectedCount;
  let modelMismatch = false;
  let nonModelInvalid = invalid;
  let modelLineage: HiggsfieldGenerationDiagnostic["modelLineage"] | undefined;
  for (const result of results) {
    if (!persistence.isCurrent()) {
      throw new ApiJobError("oauth_required", "Higgsfield 계정을 다시 연결해 주세요.", {
        status: 401,
        data: { reconnectRequired: true },
      });
    }
    if (!isRecord(result)) {
      invalid = true;
      nonModelInvalid = true;
      continue;
    }
    const providerJobId = safeId(result.id);
    if (!providerJobId) {
      invalid = true;
      nonModelInvalid = true;
      continue;
    }
    occurrences.set(providerJobId, (occurrences.get(providerJobId) ?? 0) + 1);
    observed.add(providerJobId);
    candidates.push({ result, providerJobId });
  }
  if ([...occurrences.values()].some((count) => count > 1)) {
    invalid = true;
    nonModelInvalid = true;
  }
  const parsed: StoredGenerationJob[] = [];
  for (const { result, providerJobId } of candidates) {
    const status = providerStatus(result.status);
    const remoteResultUrl = isRecord(result.results)
      ? safeHttpsUrl(result.results.rawUrl)
      : undefined;
    const explicitModel = typeof result.model === "string" ? result.model.trim() : null;
    const omittedModel =
      result.model === undefined || result.model === null || explicitModel === "";
    let resultLineage: HiggsfieldGenerationDiagnostic["modelLineage"] = "conflict";
    if (
      persistence.jobSetType === "text2image_soul_v2" &&
      expectedModelId === "soul_v2"
    ) {
      if (explicitModel === "soul_v2") resultLineage = "provider_model";
      else if (explicitModel === "text2image_soul_v2") resultLineage = "public_job_type";
      else if (
        omittedModel &&
        responseShape === "structured" &&
        results.length === 1 &&
        occurrences.get(providerJobId) === 1 &&
        status !== null
      ) {
        resultLineage = "omitted";
      }
    } else if (
      persistence.jobSetType === "gpt_image_2" &&
      expectedModelId === "gpt_image_2" &&
      explicitModel === "gpt_image_2"
    ) {
      resultLineage = "provider_model";
    }
    modelLineage =
      modelLineage === undefined || modelLineage === resultLineage
        ? resultLineage
        : "conflict";
    if (resultLineage === "conflict") {
      invalid = true;
      modelMismatch = true;
      continue;
    }
    if (occurrences.get(providerJobId) !== 1 || !status || (status === "completed" && !remoteResultUrl)) {
      invalid = true;
      nonModelInvalid = true;
      continue;
    }
    parsed.push({
      id: providerJobId,
      providerJobId,
      providerModelId: expectedModelId,
      jobSetType: persistence.jobSetType,
      status: status ?? "queued",
      params: persistence.params,
      ...(remoteResultUrl ? { remoteResultUrl } : {}),
      createdAt: persistence.now,
      expiresAt: persistence.expiresAt,
    });
  }
  if (!persistence.isCurrent()) {
    throw new ApiJobError("oauth_required", "Higgsfield 계정을 다시 연결해 주세요.", {
      status: 401,
      data: { reconnectRequired: true },
    });
  }
  if (observed.size > 0) {
    await recordObservedProviderJobIds({
      sessionFingerprint: persistence.fingerprint,
      requestId: persistence.requestId,
      providerJobIds: [...observed],
      env: persistence.env,
      now: persistence.now,
    });
  }
  if (parsed.length > 0) {
    await putGenerationJobs({
      sessionFingerprint: persistence.fingerprint,
      jobs: parsed,
      env: persistence.env,
      now: persistence.now,
    });
  }
  if (
    modelMismatch &&
    !nonModelInvalid &&
    parsed.length === 0 &&
    observed.size === expectedCount
  ) {
    throw new ApiJobError("job_mismatch", "Higgsfield 모델 계보를 확인할 수 없습니다.", {
      status: 502,
    });
  }
  if (invalid || parsed.length !== expectedCount || observed.size !== expectedCount) {
    throw new ApiJobError(
      "outcome_unknown",
      "Higgsfield 생성 접수 결과를 확인할 수 없습니다. 확인된 작업만 상태 조회하며 자동 재시도하지 않았습니다.",
      { status: 502, data: { observedProviderJobIds: [...observed] } },
    );
  }
  return { jobs: parsed, modelLineage: modelLineage ?? "conflict" };
}

function parseStatusJob(
  content: Record<string, unknown>,
  expectedJobId: string,
): { status: FnfJob["status"]; remoteResultUrl?: string } {
  if (!isRecord(content.generation)) {
    throw new ApiJobError("status_unavailable", "Higgsfield 상태를 확인할 수 없습니다.", {
      status: 502,
    });
  }
  const generation = content.generation;
  if (safeId(generation.id) !== expectedJobId) {
    throw new ApiJobError("job_mismatch", "Higgsfield 생성 계보를 확인할 수 없습니다.", {
      status: 502,
    });
  }
  const status = providerStatus(generation.status);
  if (!status) {
    throw new ApiJobError("invalid_response", "Higgsfield 상태 응답이 올바르지 않습니다.", {
      status: 502,
    });
  }
  const remoteResultUrl = isRecord(generation.results)
    ? safeHttpsUrl(generation.results.rawUrl)
    : undefined;
  if (status === "completed" && !remoteResultUrl) {
    throw new ApiJobError("invalid_response", "완료된 이미지 주소를 확인할 수 없습니다.", {
      status: 502,
    });
  }
  return { status, ...(remoteResultUrl ? { remoteResultUrl } : {}) };
}

async function storedJobsForAttempt(input: {
  fingerprint: string;
  providerJobIds: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<StoredGenerationJob[] | null> {
  const jobs = await Promise.all(
    input.providerJobIds.map((jobId) =>
      getGenerationJob({
        sessionFingerprint: input.fingerprint,
        jobId,
        env: input.env,
        now: input.now,
      }),
    ),
  );
  return jobs.every((job): job is StoredGenerationJob => job !== null) ? jobs : null;
}

function requestAlreadyUncertain(): ApiJobError {
  return new ApiJobError(
    "outcome_unknown",
    "이 생성 요청은 이미 접수됐거나 결과가 불명확합니다. 자동 재시도하지 않았습니다.",
    { status: 409 },
  );
}

function requestIdConflict(): ApiJobError {
  return new ApiJobError(
    "generation_request_id_conflict",
    "동일한 생성 요청 식별자에 다른 입력을 사용할 수 없습니다.",
    { status: 409 },
  );
}

function observedIdsFromError(error: unknown): string[] {
  if (!(error instanceof ApiJobError) || !isRecord(error.data)) return [];
  return Array.isArray(error.data.observedProviderJobIds)
    ? error.data.observedProviderJobIds.flatMap((value) => (safeId(value) ? [safeId(value)!] : []))
    : [];
}

export async function createHiggsfieldGeneration(input: {
  fingerprint: string;
  session: HiggsfieldOAuthSession;
  jobSetType: string;
  params: Record<string, unknown>;
  callTool?: ToolInvoker;
  confirmationToken?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  onGenerationDiagnostic?: (diagnostic: HiggsfieldGenerationDiagnostic) => void;
}): Promise<FnfJob[]> {
  if (input.jobSetType !== "text2image_soul_v2" && input.jobSetType !== "gpt_image_2") {
    throw new ApiJobError("unknown_model", "지원되지 않는 생성 모델입니다.", { status: 400 });
  }
  const jobSetType = input.jobSetType;
  const requestedMediaIds = extractMediaIds(input.params);
  if (
    requestedMediaIds.length > 0 &&
    !(await hasGenerationMedia({
      sessionFingerprint: input.fingerprint,
      mediaIds: requestedMediaIds,
      env: input.env,
      now: input.now,
    }))
  ) {
    throw new ApiJobError(
      "invalid_media",
      "현재 OAuth 세션에서 업로드한 이미지만 사용할 수 있습니다.",
      {
        status: 400,
      },
    );
  }
  const execution = executionParams({
    fingerprint: input.fingerprint,
    jobSetType,
    params: input.params,
  });
  if (!input.confirmationToken) {
    throw new ApiJobError("confirmation_rejected", "생성 요청 식별자를 확인할 수 없습니다.", {
      status: 400,
    });
  }
  const confirmationToken = input.confirmationToken;
  if (!isGenerationEnabled(input.env)) {
    throw new ApiJobError("generation_disabled", "현재 실제 이미지 생성이 잠겨 있습니다.", {
      status: 503,
    });
  }
  const requestHash = generationRequestHash({
    jobSetType,
    params: execution.params,
  });
  const flightKey = `${input.fingerprint}:${requestHash}`;
  const generationEpoch = generationEpochs.get(input.fingerprint) ?? 0;
  const isCurrent = () => (generationEpochs.get(input.fingerprint) ?? 0) === generationEpoch;
  const callTool =
    input.callTool ??
    ((name, args) =>
      callHiggsfieldMcpTool({
        session: input.session,
        name,
        args,
        ...(name === "generate_image" ? { preserveToolResult: true } : {}),
      }));
  const followFlight = async (flight: Promise<GenerationFlightOutcome>): Promise<FnfJob[]> => {
    const claimed = await claimGenerationAttempt({
      requestId: confirmationToken,
      sessionFingerprint: input.fingerprint,
      requestHash,
      env: input.env,
      now: input.now,
    });
    if (claimed.conflict) throw requestIdConflict();
    if (!claimed.claimed) {
      if (claimed.attempt.status === "accepted") {
        const existing = await storedJobsForAttempt({
          fingerprint: input.fingerprint,
          providerJobIds: claimed.attempt.providerJobIds,
          env: input.env,
          now: input.now,
        });
        if (existing) return existing.map(clientJob);
      }
      if (claimed.attempt.status !== "pending") throw requestAlreadyUncertain();
    }
    const outcome = await flight;
    await finishGenerationAttempt({
      sessionFingerprint: input.fingerprint,
      requestId: confirmationToken,
      status: outcome.error ? "outcome_unknown" : "accepted",
      providerJobIds: outcome.observedProviderJobIds,
      env: input.env,
      now: input.now,
    }).catch(() => undefined);
    if (outcome.error) throw outcome.error;
    return outcome.jobs.map(clientJob);
  };

  const currentFlight = generationFlights.get(flightKey);
  if (currentFlight) return followFlight(currentFlight);

  const promise = (async (): Promise<GenerationFlightOutcome> => {
    let generationStartedAt: number | undefined;
    let providerErrorPresent = false;
    let toolErrorPresent = false;
    let resultCount = 0;
    let jobIdPresent = false;
    let requestDurationMs: number | undefined;
    let responseShape: HiggsfieldMcpResponseShape = "invalid";
    let rejectionClass: HiggsfieldMcpRejectionClass = "unknown";
    let parseFailure: HiggsfieldMcpParseFailure = "missing";
    let modelLineage: HiggsfieldGenerationDiagnostic["modelLineage"] = "conflict";
    const claimed = await claimGenerationAttempt({
      requestId: confirmationToken,
      sessionFingerprint: input.fingerprint,
      requestHash,
      env: input.env,
      now: input.now,
    });
    if (claimed.conflict)
      return { jobs: [], observedProviderJobIds: [], error: requestIdConflict() };
    if (!claimed.claimed) {
      if (claimed.attempt.status === "accepted") {
        const existing = await storedJobsForAttempt({
          fingerprint: input.fingerprint,
          providerJobIds: claimed.attempt.providerJobIds,
          env: input.env,
          now: input.now,
        });
        if (existing) {
          return { jobs: existing, observedProviderJobIds: claimed.attempt.providerJobIds };
        }
      }
      return {
        jobs: [],
        observedProviderJobIds: claimed.attempt.providerJobIds,
        error: requestAlreadyUncertain(),
      };
    }
    try {
      // 한 버튼 동작은 이 단일 MCP create 호출로 끝난다. 자동 retry/fallback은 없다.
      const expectedCount = Number(execution.params.count);
      const now = input.now ?? Date.now();
      const storage = getTemporaryStorageConfig(input.env);
      if (!storage) {
        throw new ApiJobError(
          "generation_store_unavailable",
          "생성 중복 방지 저장소를 사용할 수 없어 생성을 시작하지 않았습니다.",
          { status: 503 },
        );
      }
      const ttlMs = storage.ttlMs;
      const params = storedWireParams(jobSetType, input.params);
      generationStartedAt = Date.now();
      const response = await callTool("generate_image", { params: execution.params });
      requestDurationMs = Math.max(0, Date.now() - generationStartedAt);
      toolErrorPresent = isRecord(response) && response.isError === true;
      if (!isCurrent()) {
        throw new ApiJobError("oauth_required", "Higgsfield 계정을 다시 연결해 주세요.", {
          status: 401,
          data: { reconnectRequired: true },
        });
      }
      let envelope: ReturnType<typeof structuredGenerationContent>;
      try {
        envelope = structuredGenerationContent(response);
        responseShape = envelope.responseShape;
        rejectionClass = envelope.rejectionClass;
        parseFailure = "none";
      } catch (error) {
        if (error instanceof HiggsfieldMcpContentError) {
          responseShape = error.responseShape;
          parseFailure = error.parseFailure;
        }
        throw error;
      }
      const explicitError = providerError(envelope.content);
      providerErrorPresent = explicitError !== null;
      resultCount = Array.isArray(envelope.content.results) ? envelope.content.results.length : 0;
      jobIdPresent = Array.isArray(envelope.content.results)
        ? envelope.content.results.some((result) => isRecord(result) && safeId(result.id) !== null)
        : false;
      void responseRequestId(envelope.content);
      if (explicitError) {
        rejectionClass = classifyHiggsfieldProviderRejection(explicitError);
        throw explicitProviderFailure(explicitError);
      }
      if (envelope.toolError) {
        throw toolProviderFailure(rejectionClass);
      }
      const stored = await parseAndPersistCreatedJobs(
        envelope.content,
        execution.profile.modelId,
        expectedCount,
        envelope.responseShape,
        {
          fingerprint: input.fingerprint,
          requestId: confirmationToken,
          jobSetType,
          params,
          env: input.env,
          now,
          expiresAt: now + ttlMs,
          isCurrent,
        },
      );
      modelLineage = stored.modelLineage;
      await finishGenerationAttempt({
        sessionFingerprint: input.fingerprint,
        requestId: confirmationToken,
        status: "accepted",
        providerJobIds: stored.jobs.map((job) => job.providerJobId),
        env: input.env,
        now: input.now,
      });
      return {
        jobs: stored.jobs,
        observedProviderJobIds: stored.jobs.map((job) => job.providerJobId),
      };
    } catch (error) {
      if (generationStartedAt !== undefined && requestDurationMs === undefined) {
        requestDurationMs = Math.max(0, Date.now() - generationStartedAt);
      }
      const normalizedError = generationStartedAt === undefined ? error : normalizeGenerateError(error);
      const observedProviderJobIds = observedIdsFromError(normalizedError);
      await finishGenerationAttempt({
        sessionFingerprint: input.fingerprint,
        requestId: confirmationToken,
        status: "outcome_unknown",
        ...(observedProviderJobIds.length ? { providerJobIds: observedProviderJobIds } : {}),
        env: input.env,
        now: input.now,
      }).catch(() => undefined);
      return { jobs: [], observedProviderJobIds, error: normalizedError };
    } finally {
      if (generationStartedAt !== undefined) {
        input.onGenerationDiagnostic?.({
          generationStage: "generate_image",
          providerErrorPresent,
          toolErrorPresent,
          resultCount,
          jobIdPresent,
          requestDurationMs: requestDurationMs ?? 0,
          responseShape,
          rejectionClass,
          parseFailure,
          modelLineage,
        });
      }
    }
  })();
  generationFlights.set(flightKey, promise);
  try {
    const outcome = await promise;
    if (outcome.error) throw outcome.error;
    return outcome.jobs.map(clientJob);
  } finally {
    if (generationFlights.get(flightKey) === promise) generationFlights.delete(flightKey);
    if (!isCurrent()) await clearGenerationStore(input.fingerprint, input.env);
  }
}

export async function getHiggsfieldGeneration(input: {
  fingerprint: string;
  session: HiggsfieldOAuthSession;
  jobId: string;
  callTool?: ToolInvoker;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<FnfJob> {
  const stored = await getGenerationJob({
    sessionFingerprint: input.fingerprint,
    jobId: input.jobId,
    env: input.env,
    now: input.now,
  });
  if (!stored) {
    throw new ApiJobError("not_found", "생성 작업을 찾을 수 없습니다.", { status: 404 });
  }
  if (stored.status === "queued" || stored.status === "in_progress") {
    const callTool =
      input.callTool ??
      ((name, args) => callHiggsfieldMcpTool({ session: input.session, name, args }));
    const next = parseStatusJob(
      await callTool("job_status", { jobId: stored.providerJobId, sync: false }),
      stored.providerJobId,
    );
    stored.status = next.status;
    if (next.remoteResultUrl) stored.remoteResultUrl = next.remoteResultUrl;
    if (next.status === "failed") stored.failReason = "Higgsfield generation failed";
    await putGenerationJobs({
      sessionFingerprint: input.fingerprint,
      jobs: [stored],
      env: input.env,
      now: input.now,
    });
  }
  return clientJob(stored);
}

export async function listHiggsfieldGenerations(input: {
  fingerprint: string;
  size?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ items: FnfJob[] }> {
  const size = Math.min(Math.max(input.size ?? 40, 1), 100);
  const items = (
    await listGenerationJobs({
      sessionFingerprint: input.fingerprint,
      size,
      env: input.env,
      now: input.now,
    })
  ).map(clientJob);
  return { items };
}

export async function getRemoteResultUrl(
  fingerprint: string,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const job = await getGenerationJob({ sessionFingerprint: fingerprint, jobId, env });
  return job?.status === "completed" && job.remoteResultUrl ? job.remoteResultUrl : null;
}

export async function clearGenerationRuntime(
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  generationEpochs.set(fingerprint, (generationEpochs.get(fingerprint) ?? 0) + 1);
  for (const key of generationFlights.keys()) {
    if (key.startsWith(`${fingerprint}:`)) generationFlights.delete(key);
  }
  await clearGenerationStore(fingerprint, env);
}

export function hasGenerationCapability(fingerprint: string): boolean {
  const record = getHiggsfieldCapabilityRecord(fingerprint);
  return Boolean(record?.models.every((model) => model.available));
}
