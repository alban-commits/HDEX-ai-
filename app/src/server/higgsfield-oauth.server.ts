import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { HiggsfieldOAuthConfig } from "./runtime-config.server";

export const HIGGSFIELD_OAUTH_STATE_COOKIE = "hdex_hf_oauth_state";
export const HIGGSFIELD_OAUTH_SESSION_COOKIE = "hdex_hf_oauth_session";
export const HIGGSFIELD_OAUTH_ACCESS_COOKIE = "hdex_hf_oauth_access";
export const HIGGSFIELD_OAUTH_REFRESH_COOKIE = "hdex_hf_oauth_refresh";
export const HIGGSFIELD_OAUTH_CLIENT_COOKIE = "hdex_hf_oauth_client";
export const HIGGSFIELD_OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const HIGGSFIELD_OAUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const HIGGSFIELD_OAUTH_REFRESH_WINDOW_MS = 5 * 60_000;
export const HIGGSFIELD_OAUTH_FETCH_TIMEOUT_MS = 20_000;
export const HIGGSFIELD_OAUTH_SCOPE = "openid email offline_access";
export const HIGGSFIELD_OAUTH_MAX_TOKEN_CHARS = 2_600;

const MAX_OAUTH_JSON_BYTES = 64 * 1024;
const MAX_COOKIE_VALUE_BYTES = 3_800;
const SAFE_AUTH_VALUE = /^[\x21-\x7e]{1,4096}$/;
const SAFE_TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${HIGGSFIELD_OAUTH_MAX_TOKEN_CHARS}}$`);
const SAFE_CLIENT_ID = /^[\x21-\x7e]{1,512}$/;

export const HIGGSFIELD_OAUTH_SESSION_COOKIE_NAMES = [
  HIGGSFIELD_OAUTH_SESSION_COOKIE,
  HIGGSFIELD_OAUTH_ACCESS_COOKIE,
  HIGGSFIELD_OAUTH_REFRESH_COOKIE,
  HIGGSFIELD_OAUTH_CLIENT_COOKIE,
] as const;

export type HiggsfieldOAuthCookieBundle = {
  session: string | undefined;
  access: string | undefined;
  refresh: string | undefined;
  client: string | undefined;
};

export type HiggsfieldOAuthCookieValues = {
  session: string;
  access: string;
  refresh: string;
  client: string;
};

type OAuthStatePayload = {
  schemaVersion: "hdex.higgsfield-oauth-state.v1";
  state: string;
  verifier: string;
  clientId: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  returnPath: string;
  expiresAt: number;
};

export type HiggsfieldOAuthSession = {
  schemaVersion: "hdex.higgsfield-oauth-session.v1";
  accessToken: string;
  refreshToken: string;
  clientId: string;
  tokenEndpoint: string;
  resource: string;
  accessExpiresAt: number;
  sessionExpiresAt: number;
};

type OAuthSessionMetadata = Omit<HiggsfieldOAuthSession, "accessToken" | "refreshToken" | "clientId"> & {
  bundleId: string;
};
type OAuthSecretPayload = {
  schemaVersion: "hdex.higgsfield-oauth-secret.v1";
  bundleId: string;
  value: string;
};
type OAuthServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

export type HiggsfieldOAuthStatusResult =
  | { connected: true; sessionCookies?: HiggsfieldOAuthCookieValues }
  | { connected: false; reconnectRequired: boolean };

const refreshFlights = new Map<
  string,
  { expiresAt: number; promise: Promise<HiggsfieldOAuthStatusResult> }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeOAuthReturnPath(value: unknown): string {
  const hasUnsafeCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || character === "\\";
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    hasUnsafeCharacter
  ) {
    return "/";
  }
  return value;
}

function isHiggsfieldHost(hostname: string): boolean {
  return hostname === "higgsfield.ai" || hostname.endsWith(".higgsfield.ai");
}

function assertProviderUrl(value: unknown, expectedOrigin?: string): URL {
  if (typeof value !== "string") throw new Error("higgsfield_oauth_invalid_endpoint");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !isHiggsfieldHost(url.hostname)) {
    throw new Error("higgsfield_oauth_invalid_endpoint");
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new Error("higgsfield_oauth_endpoint_origin_mismatch");
  }
  return url;
}

function normalizedIssuer(value: unknown): { url: URL; identity: string } {
  const url = assertProviderUrl(value);
  if (url.search || url.hash) throw new Error("higgsfield_oauth_invalid_issuer");
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return { url, identity: `${url.origin}${pathname}` };
}

function authorizationServerMetadataUrl(issuer: URL): URL {
  const suffix = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return new URL(`/.well-known/oauth-authorization-server${suffix}`, issuer.origin);
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_OAUTH_JSON_BYTES) {
    throw new Error("higgsfield_oauth_response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_OAUTH_JSON_BYTES) {
    throw new Error("higgsfield_oauth_response_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("higgsfield_oauth_invalid_json");
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIGGSFIELD_OAUTH_FETCH_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("higgsfield_oauth_timeout", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOAuthJson(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  return withTimeout(async (signal) => {
    const response = await fetchImpl(input, { ...init, signal, redirect: "error" });
    return { response, body: await readJson(response) };
  });
}

function resourceMetadataUrl(response: Response, resource: URL): URL {
  const challenge = response.headers.get("www-authenticate") ?? "";
  const match = challenge.match(/resource_metadata="([^"]+)"/i);
  if (!match?.[1]) throw new Error("higgsfield_oauth_resource_metadata_missing");
  return assertProviderUrl(match[1], resource.origin);
}

async function discoverOAuthMetadata(
  config: HiggsfieldOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<OAuthServerMetadata> {
  const resource = assertProviderUrl(config.mcpUrl);
  const challenge = await withTimeout((signal) =>
    fetchImpl(resource, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { Accept: "application/json, text/event-stream" },
    }),
  );
  if (challenge.status !== 401) throw new Error("higgsfield_oauth_challenge_expected");
  const protectedResult = await fetchOAuthJson(
    fetchImpl,
    resourceMetadataUrl(challenge, resource),
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!protectedResult.response.ok) throw new Error("higgsfield_oauth_resource_metadata_failed");
  const protectedMetadata = protectedResult.body;
  if (
    !isRecord(protectedMetadata) ||
    protectedMetadata.resource !== resource.toString() ||
    !Array.isArray(protectedMetadata.authorization_servers) ||
    typeof protectedMetadata.authorization_servers[0] !== "string"
  ) {
    throw new Error("higgsfield_oauth_invalid_resource_metadata");
  }
  const issuer = normalizedIssuer(protectedMetadata.authorization_servers[0]);
  const metadataResult = await fetchOAuthJson(fetchImpl, authorizationServerMetadataUrl(issuer.url), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!metadataResult.response.ok || !isRecord(metadataResult.body)) {
    throw new Error("higgsfield_oauth_server_metadata_failed");
  }
  const metadata = metadataResult.body;
  const metadataIssuer = normalizedIssuer(metadata.issuer);
  if (metadataIssuer.identity !== issuer.identity) {
    throw new Error("higgsfield_oauth_invalid_server_metadata");
  }
  const authorizationEndpoint = assertProviderUrl(metadata.authorization_endpoint, issuer.url.origin);
  const tokenEndpoint = assertProviderUrl(metadata.token_endpoint, issuer.url.origin);
  const registrationEndpoint = assertProviderUrl(metadata.registration_endpoint, issuer.url.origin);
  if (
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("higgsfield_oauth_pkce_s256_required");
  }
  const supportedScopes = Array.isArray(metadata.scopes_supported)
    ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (HIGGSFIELD_OAUTH_SCOPE.split(" ").some((scope) => !supportedScopes.includes(scope))) {
    throw new Error("higgsfield_oauth_offline_access_unsupported");
  }
  return {
    issuer: metadataIssuer.identity,
    authorization_endpoint: authorizationEndpoint.toString(),
    token_endpoint: tokenEndpoint.toString(),
    registration_endpoint: registrationEndpoint.toString(),
  };
}

function sealCookie(name: string, value: unknown, secret: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(name));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
  ]);
  const sealed = `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  if (Buffer.byteLength(sealed) > MAX_COOKIE_VALUE_BYTES) {
    throw new Error("higgsfield_oauth_cookie_too_large");
  }
  return sealed;
}

function openCookie(name: string, value: string | undefined, secret: Uint8Array): unknown {
  if (!value) return null;
  const [version, iv, encrypted, tag, extra] = value.split(".");
  if (version !== "v1" || !iv || !encrypted || !tag || extra) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function validState(value: unknown, now: number): value is OAuthStatePayload {
  return (
    isRecord(value) &&
    value.schemaVersion === "hdex.higgsfield-oauth-state.v1" &&
    typeof value.state === "string" &&
    SAFE_TOKEN.test(value.state) &&
    typeof value.verifier === "string" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(value.verifier) &&
    typeof value.clientId === "string" &&
    SAFE_CLIENT_ID.test(value.clientId) &&
    typeof value.tokenEndpoint === "string" &&
    typeof value.redirectUri === "string" &&
    typeof value.resource === "string" &&
    typeof value.returnPath === "string" &&
    safeOAuthReturnPath(value.returnPath) === value.returnPath &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > now
  );
}

function validSession(value: unknown, now: number): value is HiggsfieldOAuthSession {
  return (
    isRecord(value) &&
    value.schemaVersion === "hdex.higgsfield-oauth-session.v1" &&
    typeof value.accessToken === "string" &&
    SAFE_TOKEN.test(value.accessToken) &&
    typeof value.refreshToken === "string" &&
    SAFE_TOKEN.test(value.refreshToken) &&
    typeof value.clientId === "string" &&
    SAFE_CLIENT_ID.test(value.clientId) &&
    typeof value.tokenEndpoint === "string" &&
    typeof value.resource === "string" &&
    Number.isSafeInteger(value.accessExpiresAt) &&
    Number(value.accessExpiresAt) > 0 &&
    Number.isSafeInteger(value.sessionExpiresAt) &&
    Number(value.sessionExpiresAt) > now
  );
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function registerClient(
  metadata: OAuthServerMetadata,
  config: HiggsfieldOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const result = await fetchOAuthJson(fetchImpl, metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "HDEX Influencer Frame",
      redirect_uris: [config.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: HIGGSFIELD_OAUTH_SCOPE,
    }),
  });
  if (!result.response.ok || !isRecord(result.body)) {
    throw new Error("higgsfield_oauth_registration_failed");
  }
  const clientId = result.body.client_id;
  if (typeof clientId !== "string" || !SAFE_CLIENT_ID.test(clientId)) {
    throw new Error("higgsfield_oauth_invalid_registration");
  }
  return clientId;
}

export async function beginHiggsfieldOAuth(
  config: HiggsfieldOAuthConfig,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  returnPath = "/",
): Promise<{ authorizationUrl: string; stateCookie: string }> {
  const metadata = await discoverOAuthMetadata(config, fetchImpl);
  const clientId = await registerClient(metadata, config, fetchImpl);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const authorization = new URL(metadata.authorization_endpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", config.callbackUrl);
  authorization.searchParams.set("scope", HIGGSFIELD_OAUTH_SCOPE);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", config.mcpUrl);
  return {
    authorizationUrl: authorization.toString(),
    stateCookie: sealCookie(
      HIGGSFIELD_OAUTH_STATE_COOKIE,
      {
        schemaVersion: "hdex.higgsfield-oauth-state.v1",
        state,
        verifier,
        clientId,
        tokenEndpoint: metadata.token_endpoint,
        redirectUri: config.callbackUrl,
        resource: config.mcpUrl,
        returnPath: safeOAuthReturnPath(returnPath),
        expiresAt: now + HIGGSFIELD_OAUTH_STATE_TTL_SECONDS * 1_000,
      } satisfies OAuthStatePayload,
      config.cookieSecret,
    ),
  };
}

function validatedState(input: {
  config: HiggsfieldOAuthConfig;
  stateCookie: string | undefined;
  returnedState: string | null;
  now: number;
}): OAuthStatePayload {
  const stored = openCookie(
    HIGGSFIELD_OAUTH_STATE_COOKIE,
    input.stateCookie,
    input.config.cookieSecret,
  );
  if (
    !validState(stored, input.now) ||
    !input.returnedState ||
    !secureEqual(stored.state, input.returnedState) ||
    stored.redirectUri !== input.config.callbackUrl ||
    stored.resource !== input.config.mcpUrl
  ) {
    throw new Error("higgsfield_oauth_state_invalid");
  }
  return stored;
}

export function validateHiggsfieldOAuthCallbackState(input: {
  config: HiggsfieldOAuthConfig;
  stateCookie: string | undefined;
  returnedState: string | null;
  now?: number;
}): string {
  return validatedState({ ...input, now: input.now ?? Date.now() }).returnPath;
}

async function exchangeToken(
  endpoint: string,
  values: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const result = await fetchOAuthJson(fetchImpl, endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(values),
  });
  if (!result.response.ok || !isRecord(result.body)) {
    throw new Error("higgsfield_oauth_token_exchange_failed");
  }
  return result.body;
}

function parseTokenResponse(body: Record<string, unknown>) {
  if (
    typeof body.access_token !== "string" ||
    !SAFE_TOKEN.test(body.access_token) ||
    (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") ||
    !Number.isSafeInteger(body.expires_in) ||
    Number(body.expires_in) <= 0 ||
    Number(body.expires_in) > 30 * 24 * 60 * 60
  ) {
    throw new Error("higgsfield_oauth_invalid_token_response");
  }
  if (
    body.refresh_token !== undefined &&
    (typeof body.refresh_token !== "string" || !SAFE_TOKEN.test(body.refresh_token))
  ) {
    throw new Error("higgsfield_oauth_invalid_token_response");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresIn: Number(body.expires_in),
  };
}

function secretPayload(value: string, bundleId: string): OAuthSecretPayload {
  return { schemaVersion: "hdex.higgsfield-oauth-secret.v1", bundleId, value };
}

function sealSession(
  config: HiggsfieldOAuthConfig,
  session: HiggsfieldOAuthSession,
): HiggsfieldOAuthCookieValues {
  const bundleId = randomBytes(32).toString("base64url");
  const metadata: OAuthSessionMetadata = {
    schemaVersion: session.schemaVersion,
    tokenEndpoint: session.tokenEndpoint,
    resource: session.resource,
    accessExpiresAt: session.accessExpiresAt,
    sessionExpiresAt: session.sessionExpiresAt,
    bundleId,
  };
  return {
    session: sealCookie(HIGGSFIELD_OAUTH_SESSION_COOKIE, metadata, config.cookieSecret),
    access: sealCookie(
      HIGGSFIELD_OAUTH_ACCESS_COOKIE,
      secretPayload(session.accessToken, bundleId),
      config.cookieSecret,
    ),
    refresh: sealCookie(
      HIGGSFIELD_OAUTH_REFRESH_COOKIE,
      secretPayload(session.refreshToken, bundleId),
      config.cookieSecret,
    ),
    client: sealCookie(
      HIGGSFIELD_OAUTH_CLIENT_COOKIE,
      secretPayload(session.clientId, bundleId),
      config.cookieSecret,
    ),
  };
}

export async function completeHiggsfieldOAuth(input: {
  config: HiggsfieldOAuthConfig;
  stateCookie: string | undefined;
  returnedState: string | null;
  code: string | null;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<{ sessionCookies: HiggsfieldOAuthCookieValues; returnPath: string }> {
  const now = input.now ?? Date.now();
  const stored = validatedState({ ...input, now });
  if (!input.code || !SAFE_AUTH_VALUE.test(input.code)) {
    throw new Error("higgsfield_oauth_state_invalid");
  }
  const body = await exchangeToken(
    stored.tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: stored.clientId,
      code: input.code,
      redirect_uri: stored.redirectUri,
      code_verifier: stored.verifier,
      resource: stored.resource,
      scope: HIGGSFIELD_OAUTH_SCOPE,
    },
    input.fetchImpl ?? fetch,
  );
  const token = parseTokenResponse(body);
  if (!token.refreshToken) throw new Error("higgsfield_oauth_refresh_token_required");
  return {
    returnPath: stored.returnPath,
    sessionCookies: sealSession(input.config, {
      schemaVersion: "hdex.higgsfield-oauth-session.v1",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      clientId: stored.clientId,
      tokenEndpoint: stored.tokenEndpoint,
      resource: stored.resource,
      accessExpiresAt: now + token.expiresIn * 1_000,
      sessionExpiresAt: now + HIGGSFIELD_OAUTH_SESSION_TTL_SECONDS * 1_000,
    }),
  };
}

function readSecret(
  name: string,
  cookie: string | undefined,
  secret: Uint8Array,
  validator: RegExp,
): { bundleId: string; value: string } | null {
  const value = openCookie(name, cookie, secret);
  return isRecord(value) &&
    value.schemaVersion === "hdex.higgsfield-oauth-secret.v1" &&
    typeof value.bundleId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.bundleId) &&
    typeof value.value === "string" &&
    validator.test(value.value)
    ? { bundleId: value.bundleId, value: value.value }
    : null;
}

export function readHiggsfieldOAuthSession(
  config: HiggsfieldOAuthConfig,
  cookies: HiggsfieldOAuthCookieBundle,
  now = Date.now(),
): HiggsfieldOAuthSession | null {
  const metadata = openCookie(
    HIGGSFIELD_OAUTH_SESSION_COOKIE,
    cookies.session,
    config.cookieSecret,
  );
  if (!isRecord(metadata)) return null;
  if (typeof metadata.bundleId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(metadata.bundleId)) {
    return null;
  }
  const access = readSecret(
    HIGGSFIELD_OAUTH_ACCESS_COOKIE,
    cookies.access,
    config.cookieSecret,
    SAFE_TOKEN,
  );
  const refresh = readSecret(
    HIGGSFIELD_OAUTH_REFRESH_COOKIE,
    cookies.refresh,
    config.cookieSecret,
    SAFE_TOKEN,
  );
  const client = readSecret(
    HIGGSFIELD_OAUTH_CLIENT_COOKIE,
    cookies.client,
    config.cookieSecret,
    SAFE_CLIENT_ID,
  );
  if (
    !access || !refresh || !client ||
    access.bundleId !== metadata.bundleId ||
    refresh.bundleId !== metadata.bundleId ||
    client.bundleId !== metadata.bundleId
  ) return null;
  const value = {
    ...metadata,
    accessToken: access.value,
    refreshToken: refresh.value,
    clientId: client.value,
  };
  if (!validSession(value, now)) return null;
  try {
    assertProviderUrl(value.tokenEndpoint);
    return value.resource === config.mcpUrl ? value : null;
  } catch {
    return null;
  }
}

export function higgsfieldOAuthSessionFingerprint(session: HiggsfieldOAuthSession): string {
  return createHash("sha256")
    .update("hdex.higgsfield-oauth-session-fingerprint.v1\0")
    .update(session.resource)
    .update("\0")
    .update(session.clientId)
    .update("\0")
    .update(String(session.sessionExpiresAt))
    .digest("base64url");
}

function flightKey(cookies: HiggsfieldOAuthCookieBundle): string {
  return createHash("sha256")
    .update(cookies.session ?? "")
    .update("\0")
    .update(cookies.access ?? "")
    .update("\0")
    .update(cookies.refresh ?? "")
    .update("\0")
    .update(cookies.client ?? "")
    .digest("base64url");
}

async function refreshSession(
  config: HiggsfieldOAuthConfig,
  session: HiggsfieldOAuthSession,
  fetchImpl: typeof fetch,
  now: number,
): Promise<HiggsfieldOAuthStatusResult> {
  try {
    const body = await exchangeToken(
      session.tokenEndpoint,
      {
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: session.refreshToken,
        resource: session.resource,
        scope: HIGGSFIELD_OAUTH_SCOPE,
      },
      fetchImpl,
    );
    const token = parseTokenResponse(body);
    return {
      connected: true,
      sessionCookies: sealSession(config, {
        ...session,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? session.refreshToken,
        accessExpiresAt: now + token.expiresIn * 1_000,
      }),
    };
  } catch {
    return { connected: false, reconnectRequired: true };
  }
}

export async function getHiggsfieldOAuthStatus(input: {
  config: HiggsfieldOAuthConfig;
  sessionCookies: HiggsfieldOAuthCookieBundle;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<HiggsfieldOAuthStatusResult> {
  const now = input.now ?? Date.now();
  const session = readHiggsfieldOAuthSession(input.config, input.sessionCookies, now);
  if (!session) return { connected: false, reconnectRequired: false };
  if (session.accessExpiresAt - now > HIGGSFIELD_OAUTH_REFRESH_WINDOW_MS) {
    return { connected: true };
  }
  for (const [key, value] of refreshFlights) {
    if (value.expiresAt <= now) refreshFlights.delete(key);
  }
  const key = flightKey(input.sessionCookies);
  const existing = refreshFlights.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  const promise = refreshSession(input.config, session, input.fetchImpl ?? fetch, now);
  refreshFlights.set(key, {
    expiresAt: Math.min(session.sessionExpiresAt, now + HIGGSFIELD_OAUTH_REFRESH_WINDOW_MS),
    promise,
  });
  return promise;
}
