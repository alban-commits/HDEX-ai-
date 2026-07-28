import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiJobError } from "@higgsfield/fnf/errors";
import { getTemporaryStorageConfig } from "./runtime-config.server";

export type StoredGenerationJob = {
  id: string;
  providerJobId: string;
  providerModelId: string;
  jobSetType: "text2image_soul_v2" | "gpt_image_2";
  status: "queued" | "in_progress" | "completed" | "failed" | "canceled";
  createdAt: number;
  expiresAt: number;
  remoteResultUrl?: string;
  failReason?: string;
  params: Record<string, unknown>;
};

export type GenerationAttempt = {
  requestId: string;
  sessionFingerprint: string;
  requestHash: string;
  status: "pending" | "accepted" | "outcome_unknown";
  providerJobIds: string[];
  createdAt: number;
  expiresAt: number;
};

type SessionState = {
  attempts: Map<string, GenerationAttempt>;
  jobs: Map<string, StoredGenerationJob>;
  media: Map<string, number>;
};

type StorePaths = {
  directory: string;
  stateFile: string;
  lockRoot: string;
  lockDirectory: string;
  revocationFile: string;
};

export type GenerationStoreTestHooks = {
  afterRead?: () => Promise<void>;
  beforePersist?: () => Promise<void>;
};

export const GENERATION_STATE_SCHEMA_VERSION = "hdex.generation-state.v1";
const REVOCATION_SCHEMA_VERSION = "hdex.generation-revocation.v1";
const ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,240}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_HASH = /^[a-f0-9]{64}$/;

const states = new Map<string, SessionState>();
const loaded = new Set<string>();
const loadFlights = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();
const invalidating = new Set<string>();
const clearFlights = new Map<string, Promise<void>>();

function emptyState(): SessionState {
  return { attempts: new Map(), jobs: new Map(), media: new Map() };
}

function safeFingerprint(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error("invalid_session_fingerprint");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function storeUnavailable(_cause?: unknown): ApiJobError {
  return new ApiJobError(
    "generation_store_unavailable",
    "생성 중복 방지 저장소를 사용할 수 없어 생성을 시작하지 않았습니다.",
    { status: 503 },
  );
}

function storeCorrupt(_cause?: unknown): ApiJobError {
  return new ApiJobError(
    "generation_store_corrupt",
    "생성 중복 방지 저장소의 무결성을 확인할 수 없어 생성을 시작하지 않았습니다.",
    { status: 503 },
  );
}

function storeInvalidated(): ApiJobError {
  return new ApiJobError(
    "generation_store_invalidated",
    "연결 해제로 생성 상태가 무효화되어 작업을 시작하지 않았습니다.",
    { status: 409 },
  );
}

function pathsFor(fingerprint: string, env: NodeJS.ProcessEnv): StorePaths {
  const config = getTemporaryStorageConfig(env);
  if (!config) throw storeUnavailable();
  const name = safeFingerprint(fingerprint);
  const directory = join(config.rootDirectory, "jobs");
  // Generic TTL maintenance only owns uploads/downloads/jobs. Claim locks are
  // deliberately outside those trees: an active empty lock directory must
  // never be mistaken for expired temporary data. Stale locks remain a manual,
  // fail-closed operational recovery instead of being removed by age alone.
  const lockRoot = join(config.rootDirectory, "generation-locks");
  return {
    directory,
    stateFile: join(directory, `${name}.json`),
    lockRoot,
    lockDirectory: join(lockRoot, `${name}.claim.lock`),
    revocationFile: join(directory, `.${name}.revocation.json`),
  };
}

function epochFor(fingerprint: string): number {
  return epochs.get(fingerprint) ?? 0;
}

function assertCurrent(fingerprint: string, epoch: number): void {
  if (invalidating.has(fingerprint) || epochFor(fingerprint) !== epoch) {
    throw storeInvalidated();
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseAttempt(value: unknown, fingerprint: string): GenerationAttempt {
  if (!isRecord(value)) throw storeCorrupt();
  const status = value.status;
  const providerJobIds = value.providerJobIds;
  if (
    typeof value.requestId !== "string" ||
    !SAFE_REQUEST_ID.test(value.requestId) ||
    value.sessionFingerprint !== fingerprint ||
    typeof value.requestHash !== "string" ||
    !SAFE_HASH.test(value.requestHash) ||
    (status !== "pending" && status !== "accepted" && status !== "outcome_unknown") ||
    !Array.isArray(providerJobIds) ||
    providerJobIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
    new Set(providerJobIds).size !== providerJobIds.length ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.expiresAt) ||
    value.expiresAt <= value.createdAt
  ) throw storeCorrupt();
  return {
    requestId: value.requestId,
    sessionFingerprint: fingerprint,
    requestHash: value.requestHash,
    status,
    providerJobIds: [...providerJobIds],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function parseJob(value: unknown): StoredGenerationJob {
  if (!isRecord(value)) throw storeCorrupt();
  const status = value.status;
  const jobSetType = value.jobSetType;
  if (
    typeof value.id !== "string" ||
    !SAFE_ID.test(value.id) ||
    value.providerJobId !== value.id ||
    typeof value.providerModelId !== "string" ||
    !SAFE_ID.test(value.providerModelId) ||
    (jobSetType !== "text2image_soul_v2" && jobSetType !== "gpt_image_2") ||
    (status !== "queued" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "canceled") ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.expiresAt) ||
    value.expiresAt <= value.createdAt ||
    !isRecord(value.params) ||
    (value.remoteResultUrl !== undefined && !validHttpsUrl(value.remoteResultUrl)) ||
    (status === "completed" && !validHttpsUrl(value.remoteResultUrl)) ||
    (value.failReason !== undefined && typeof value.failReason !== "string")
  ) throw storeCorrupt();
  return {
    id: value.id,
    providerJobId: value.id,
    providerModelId: value.providerModelId,
    jobSetType,
    status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(value.remoteResultUrl ? { remoteResultUrl: value.remoteResultUrl } : {}),
    ...(value.failReason ? { failReason: value.failReason } : {}),
    params: value.params,
  };
}

function parseState(value: unknown, fingerprint: string, revocation: string): SessionState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== GENERATION_STATE_SCHEMA_VERSION ||
    value.sessionFingerprint !== fingerprint ||
    value.revocationToken !== revocation ||
    !Array.isArray(value.attempts) ||
    !Array.isArray(value.jobs) ||
    !Array.isArray(value.media)
  ) throw storeCorrupt();
  const state = emptyState();
  for (const item of value.attempts) {
    const attempt = parseAttempt(item, fingerprint);
    if (state.attempts.has(attempt.requestId)) throw storeCorrupt();
    state.attempts.set(attempt.requestId, attempt);
  }
  for (const item of value.jobs) {
    const job = parseJob(item);
    if (state.jobs.has(job.id)) throw storeCorrupt();
    state.jobs.set(job.id, job);
  }
  for (const item of value.media) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !SAFE_ID.test(item.id) ||
      !validTimestamp(item.expiresAt) ||
      state.media.has(item.id)
    ) throw storeCorrupt();
    state.media.set(item.id, item.expiresAt);
  }
  return state;
}

function serializeState(fingerprint: string, revocation: string, state: SessionState): string {
  return JSON.stringify({
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    sessionFingerprint: fingerprint,
    revocationToken: revocation,
    attempts: [...state.attempts.values()],
    jobs: [...state.jobs.values()],
    media: [...state.media].map(([id, expiresAt]) => ({ id, expiresAt })),
  });
}

function purge(state: SessionState, now: number): void {
  for (const [key, attempt] of state.attempts) {
    if (attempt.expiresAt <= now) state.attempts.delete(key);
  }
  for (const [key, job] of state.jobs) {
    if (job.expiresAt <= now) state.jobs.delete(key);
  }
  for (const [key, expiresAt] of state.media) {
    if (expiresAt <= now) state.media.delete(key);
  }
}

async function readState(
  paths: StorePaths,
  fingerprint: string,
  revocation: string,
): Promise<SessionState> {
  let source: string;
  try {
    source = await readFile(paths.stateFile, "utf8");
  } catch (error) {
    if (isFsError(error, "ENOENT")) return emptyState();
    throw storeUnavailable(error);
  }
  try {
    return parseState(JSON.parse(source), fingerprint, revocation);
  } catch (error) {
    if (error instanceof ApiJobError) throw error;
    throw storeCorrupt(error);
  }
}

async function readRevocation(paths: StorePaths): Promise<string> {
  let source: string;
  try {
    source = await readFile(paths.revocationFile, "utf8");
  } catch (error) {
    if (isFsError(error, "ENOENT")) return "initial";
    throw storeUnavailable(error);
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== REVOCATION_SCHEMA_VERSION ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9]{32}$/.test(parsed.token)
    ) throw storeCorrupt();
    return parsed.token;
  } catch (error) {
    if (error instanceof ApiJobError) throw error;
    throw storeCorrupt(error);
  }
}

async function atomicWrite(file: string, directory: string, contents: string): Promise<void> {
  const temporary = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isFsError(cleanupError, "ENOENT")) {
        throw storeUnavailable(cleanupError);
      }
    }
    throw storeUnavailable(error);
  }
}

async function acquireLock(paths: StorePaths): Promise<() => Promise<void>> {
  try {
    await Promise.all([
      mkdir(paths.directory, { recursive: true, mode: 0o700 }),
      mkdir(paths.lockRoot, { recursive: true, mode: 0o700 }),
    ]);
  } catch (error) {
    throw storeUnavailable(error);
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(paths.lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw storeUnavailable(error);
      if (Date.now() >= deadline) throw storeUnavailable(error);
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  return async () => {
    try {
      await rmdir(paths.lockDirectory);
    } catch (error) {
      throw storeUnavailable(error);
    }
  };
}

async function withLock<T>(paths: StorePaths, operation: () => Promise<T>): Promise<T> {
  const release = await acquireLock(paths);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await release();
    } catch {
      // The original fail-closed error is more actionable than a secondary release failure.
    }
    throw error;
  }
  await release();
  return result;
}

async function loadSession(
  fingerprint: string,
  env: NodeJS.ProcessEnv,
  now: number,
  hooks?: GenerationStoreTestHooks,
  fresh = false,
): Promise<void> {
  safeFingerprint(fingerprint);
  if (!fresh && loaded.has(fingerprint)) return;
  const existing = loadFlights.get(fingerprint);
  if (existing) return existing;
  const paths = pathsFor(fingerprint, env);
  const epoch = epochFor(fingerprint);
  const flight = withLock(paths, async () => {
    assertCurrent(fingerprint, epoch);
    const revocation = await readRevocation(paths);
    const state = await readState(paths, fingerprint, revocation);
    purge(state, now);
    await hooks?.afterRead?.();
    assertCurrent(fingerprint, epoch);
    if ((await readRevocation(paths)) !== revocation) throw storeInvalidated();
    states.set(fingerprint, state);
    loaded.add(fingerprint);
  });
  loadFlights.set(fingerprint, flight);
  try {
    await flight;
  } finally {
    if (loadFlights.get(fingerprint) === flight) loadFlights.delete(fingerprint);
  }
}

async function mutateSession<T>(input: {
  fingerprint: string;
  env: NodeJS.ProcessEnv;
  now: number;
  hooks?: GenerationStoreTestHooks;
  mutate: (state: SessionState) => { changed: boolean; value: T };
}): Promise<T> {
  await loadSession(input.fingerprint, input.env, input.now, input.hooks);
  const paths = pathsFor(input.fingerprint, input.env);
  const epoch = epochFor(input.fingerprint);
  const revocation = await readRevocation(paths);
  return withLock(paths, async () => {
    assertCurrent(input.fingerprint, epoch);
    if ((await readRevocation(paths)) !== revocation) throw storeInvalidated();
    const state = await readState(paths, input.fingerprint, revocation);
    purge(state, input.now);
    const mutation = input.mutate(state);
    if (mutation.changed) {
      await input.hooks?.beforePersist?.();
      assertCurrent(input.fingerprint, epoch);
      if ((await readRevocation(paths)) !== revocation) throw storeInvalidated();
      await atomicWrite(
        paths.stateFile,
        paths.directory,
        serializeState(input.fingerprint, revocation, state),
      );
    }
    assertCurrent(input.fingerprint, epoch);
    states.set(input.fingerprint, state);
    loaded.add(input.fingerprint);
    return mutation.value;
  });
}

export function generationRequestHash(value: unknown): string {
  function stable(item: unknown): string {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
    return `{${Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return createHash("sha256").update(stable(value)).digest("hex");
}

export async function claimGenerationAttempt(input: {
  requestId: string;
  sessionFingerprint: string;
  requestHash: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  testHooks?: GenerationStoreTestHooks;
}): Promise<{ claimed: boolean; conflict: boolean; attempt: GenerationAttempt }> {
  if (!SAFE_REQUEST_ID.test(input.requestId)) throw new Error("invalid_request_id");
  if (!SAFE_HASH.test(input.requestHash)) throw new Error("invalid_request_hash");
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const config = getTemporaryStorageConfig(env);
  if (!config) throw storeUnavailable();
  return mutateSession<{ claimed: boolean; conflict: boolean; attempt: GenerationAttempt }>({
    fingerprint: input.sessionFingerprint,
    env,
    now,
    hooks: input.testHooks,
    mutate(state) {
      const existing = state.attempts.get(input.requestId);
      if (existing) {
        return {
          changed: false,
          value: {
            claimed: false,
            conflict: existing.requestHash !== input.requestHash,
            attempt: existing,
          },
        };
      }
      const attempt: GenerationAttempt = {
        requestId: input.requestId,
        sessionFingerprint: input.sessionFingerprint,
        requestHash: input.requestHash,
        status: "pending",
        providerJobIds: [],
        createdAt: now,
        expiresAt: now + Math.min(config.ttlMs, ATTEMPT_TTL_MS),
      };
      state.attempts.set(input.requestId, attempt);
      return { changed: true, value: { claimed: true, conflict: false, attempt } };
    },
  });
}

export async function finishGenerationAttempt(input: {
  sessionFingerprint: string;
  requestId: string;
  status: "accepted" | "outcome_unknown";
  providerJobIds?: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<void> {
  const env = input.env ?? process.env;
  await mutateSession({
    fingerprint: input.sessionFingerprint,
    env,
    now: input.now ?? Date.now(),
    mutate(state) {
      const attempt = state.attempts.get(input.requestId);
      if (!attempt) throw new Error("attempt_not_found");
      attempt.status = input.status;
      if (input.providerJobIds) attempt.providerJobIds = [...new Set(input.providerJobIds)];
      return { changed: true, value: undefined };
    },
  });
}

export async function recordObservedProviderJobIds(input: {
  sessionFingerprint: string;
  requestId: string;
  providerJobIds: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<void> {
  const env = input.env ?? process.env;
  await mutateSession({
    fingerprint: input.sessionFingerprint,
    env,
    now: input.now ?? Date.now(),
    mutate(state) {
      const attempt = state.attempts.get(input.requestId);
      if (!attempt) throw new Error("attempt_not_found");
      const safeIds = input.providerJobIds.filter((id) => SAFE_ID.test(id));
      attempt.providerJobIds = [...new Set([...attempt.providerJobIds, ...safeIds])];
      return { changed: true, value: undefined };
    },
  });
}

export async function putGenerationJobs(input: {
  sessionFingerprint: string;
  jobs: StoredGenerationJob[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<void> {
  const env = input.env ?? process.env;
  await mutateSession({
    fingerprint: input.sessionFingerprint,
    env,
    now: input.now ?? Date.now(),
    mutate(state) {
      for (const job of input.jobs) state.jobs.set(job.id, job);
      return { changed: input.jobs.length > 0, value: undefined };
    },
  });
}

export async function registerGenerationMedia(input: {
  sessionFingerprint: string;
  mediaId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<void> {
  if (!SAFE_ID.test(input.mediaId)) throw new Error("invalid_media_id");
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const config = getTemporaryStorageConfig(env);
  if (!config) throw storeUnavailable();
  await mutateSession({
    fingerprint: input.sessionFingerprint,
    env,
    now,
    mutate(state) {
      state.media.set(input.mediaId, now + config.ttlMs);
      return { changed: true, value: undefined };
    },
  });
}

export async function hasGenerationMedia(input: {
  sessionFingerprint: string;
  mediaIds: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  await loadSession(input.sessionFingerprint, env, now, undefined, true);
  const state = states.get(input.sessionFingerprint) ?? emptyState();
  return input.mediaIds.every((mediaId) => state.media.has(mediaId));
}

export async function getGenerationJob(input: {
  sessionFingerprint: string;
  jobId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<StoredGenerationJob | null> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  await loadSession(input.sessionFingerprint, env, now, undefined, true);
  return states.get(input.sessionFingerprint)?.jobs.get(input.jobId) ?? null;
}

export async function listGenerationJobs(input: {
  sessionFingerprint: string;
  size: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<StoredGenerationJob[]> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  await loadSession(input.sessionFingerprint, env, now, undefined, true);
  return [...(states.get(input.sessionFingerprint)?.jobs.values() ?? [])]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, input.size);
}

export async function clearGenerationStore(
  sessionFingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const existing = clearFlights.get(sessionFingerprint);
  if (existing) return existing;
  const flight = (async () => {
    safeFingerprint(sessionFingerprint);
    invalidating.add(sessionFingerprint);
    epochs.set(sessionFingerprint, epochFor(sessionFingerprint) + 1);
    states.delete(sessionFingerprint);
    loaded.delete(sessionFingerprint);
    const config = getTemporaryStorageConfig(env);
    if (!config) return;
    const paths = pathsFor(sessionFingerprint, env);
    await withLock(paths, async () => {
      const token = randomBytes(16).toString("hex");
      await atomicWrite(
        paths.revocationFile,
        paths.directory,
        JSON.stringify({ schemaVersion: REVOCATION_SCHEMA_VERSION, token }),
      );
      try {
        await unlink(paths.stateFile);
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw storeUnavailable(error);
      }
    });
  })();
  clearFlights.set(sessionFingerprint, flight);
  try {
    await flight;
  } finally {
    epochs.set(sessionFingerprint, epochFor(sessionFingerprint) + 1);
    states.delete(sessionFingerprint);
    loaded.delete(sessionFingerprint);
    invalidating.delete(sessionFingerprint);
    if (clearFlights.get(sessionFingerprint) === flight) clearFlights.delete(sessionFingerprint);
  }
}
