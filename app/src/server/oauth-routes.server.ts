import {
  beginHiggsfieldOAuth,
  completeHiggsfieldOAuth,
  getHiggsfieldOAuthStatus,
  higgsfieldOAuthSessionFingerprint,
  HIGGSFIELD_OAUTH_ACCESS_COOKIE,
  HIGGSFIELD_OAUTH_CLIENT_COOKIE,
  HIGGSFIELD_OAUTH_REFRESH_COOKIE,
  HIGGSFIELD_OAUTH_SESSION_COOKIE,
  HIGGSFIELD_OAUTH_SESSION_COOKIE_NAMES,
  HIGGSFIELD_OAUTH_SESSION_TTL_SECONDS,
  HIGGSFIELD_OAUTH_STATE_COOKIE,
  HIGGSFIELD_OAUTH_STATE_TTL_SECONDS,
  readHiggsfieldOAuthSession,
  validateHiggsfieldOAuthCallbackState,
  type HiggsfieldOAuthCookieBundle,
  type HiggsfieldOAuthCookieValues,
  type HiggsfieldOAuthSession,
} from "./higgsfield-oauth.server";
import {
  appendSealedCookie,
  clearSealedCookie,
  NO_STORE_HEADERS,
  readCookie,
  redirectNoStore,
  rejectCrossSiteMutation,
} from "./http.server";
import {
  getHiggsfieldOAuthConfig,
  type HiggsfieldOAuthConfig,
} from "./runtime-config.server";

export type ActiveOAuthSession = {
  config: HiggsfieldOAuthConfig;
  session: HiggsfieldOAuthSession;
  rotatedCookies?: HiggsfieldOAuthCookieValues;
};

export function readOAuthCookies(request: Request): HiggsfieldOAuthCookieBundle {
  return {
    session: readCookie(request, HIGGSFIELD_OAUTH_SESSION_COOKIE),
    access: readCookie(request, HIGGSFIELD_OAUTH_ACCESS_COOKIE),
    refresh: readCookie(request, HIGGSFIELD_OAUTH_REFRESH_COOKIE),
    client: readCookie(request, HIGGSFIELD_OAUTH_CLIENT_COOKIE),
  };
}

export function appendOAuthSessionCookies(
  headers: Headers,
  values: HiggsfieldOAuthCookieValues,
): void {
  for (const [name, value] of [
    [HIGGSFIELD_OAUTH_SESSION_COOKIE, values.session],
    [HIGGSFIELD_OAUTH_ACCESS_COOKIE, values.access],
    [HIGGSFIELD_OAUTH_REFRESH_COOKIE, values.refresh],
    [HIGGSFIELD_OAUTH_CLIENT_COOKIE, values.client],
  ] as const) {
    appendSealedCookie(headers, name, value, {
      path: "/",
      maxAge: HIGGSFIELD_OAUTH_SESSION_TTL_SECONDS,
    });
  }
}

export function clearAllOAuthCookies(headers: Headers): void {
  for (const name of HIGGSFIELD_OAUTH_SESSION_COOKIE_NAMES) {
    clearSealedCookie(headers, name, "/");
  }
  clearSealedCookie(headers, HIGGSFIELD_OAUTH_STATE_COOKIE, "/api/higgsfield/oauth");
}

export async function requireActiveOAuthSession(
  request: Request,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<ActiveOAuthSession | null> {
  const config = getHiggsfieldOAuthConfig(options.env);
  if (!config) return null;
  const original = readOAuthCookies(request);
  const status = await getHiggsfieldOAuthStatus({
    config,
    sessionCookies: original,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  if (!status.connected) return null;
  const effective = status.sessionCookies ?? original;
  const session = readHiggsfieldOAuthSession(config, effective, options.now);
  if (!session) return null;
  return {
    config,
    session,
    ...(status.sessionCookies ? { rotatedCookies: status.sessionCookies } : {}),
  };
}

function oauthRedirect(
  config: HiggsfieldOAuthConfig,
  returnPath: string,
  status: "connected" | "error",
  reason?: string,
) {
  const target = new URL(returnPath, config.publicOrigin);
  if (status === "error") {
    target.searchParams.set("higgsfield", status);
    if (reason) target.searchParams.set("reason", reason);
  }
  return redirectNoStore(target.toString());
}

function callbackFailureReason(error: unknown): "state_invalid" | "timeout" | "provider_error" {
  if (!(error instanceof Error)) return "provider_error";
  if (error.message === "higgsfield_oauth_state_invalid") return "state_invalid";
  if (error.message === "higgsfield_oauth_timeout") return "timeout";
  return "provider_error";
}

export async function handleOAuthConnect(
  request: Request,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Response> {
  const config = getHiggsfieldOAuthConfig(options.env);
  if (!config) {
    return Response.json(
      { error: "oauth_not_configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const crossSite = rejectCrossSiteMutation(request, config.publicOrigin);
  if (crossSite) return crossSite;
  try {
    const returnPath = new URL(request.url).searchParams.get("return") ?? "/";
    const started = await beginHiggsfieldOAuth(
      config,
      options.fetchImpl,
      options.now,
      returnPath,
    );
    const response = redirectNoStore(started.authorizationUrl);
    appendSealedCookie(response.headers, HIGGSFIELD_OAUTH_STATE_COOKIE, started.stateCookie, {
      path: "/api/higgsfield/oauth",
      maxAge: HIGGSFIELD_OAUTH_STATE_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    return oauthRedirect(
      config,
      "/",
      "error",
      error instanceof Error && error.message === "higgsfield_oauth_timeout"
        ? "timeout"
        : "start_failed",
    );
  }
}

export async function handleOAuthCallback(
  request: Request,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Response> {
  const config = getHiggsfieldOAuthConfig(options.env);
  if (!config) {
    return Response.json(
      { error: "oauth_not_configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const url = new URL(request.url);
  const stateCookie = readCookie(request, HIGGSFIELD_OAUTH_STATE_COOKIE);
  let returnPath: string;
  try {
    returnPath = validateHiggsfieldOAuthCallbackState({
      config,
      stateCookie,
      returnedState: url.searchParams.get("state"),
      now: options.now,
    });
  } catch {
    const response = oauthRedirect(config, "/", "error", "state_invalid");
    clearSealedCookie(response.headers, HIGGSFIELD_OAUTH_STATE_COOKIE, "/api/higgsfield/oauth");
    return response;
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const reason = providerError === "access_denied" ? "canceled" : "provider_error";
    const response = oauthRedirect(config, returnPath, "error", reason);
    clearSealedCookie(response.headers, HIGGSFIELD_OAUTH_STATE_COOKIE, "/api/higgsfield/oauth");
    return response;
  }
  try {
    const completed = await completeHiggsfieldOAuth({
      config,
      stateCookie,
      returnedState: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
    const response = oauthRedirect(config, completed.returnPath, "connected");
    clearSealedCookie(response.headers, HIGGSFIELD_OAUTH_STATE_COOKIE, "/api/higgsfield/oauth");
    appendOAuthSessionCookies(response.headers, completed.sessionCookies);
    return response;
  } catch (error) {
    const response = oauthRedirect(config, returnPath, "error", callbackFailureReason(error));
    clearSealedCookie(response.headers, HIGGSFIELD_OAUTH_STATE_COOKIE, "/api/higgsfield/oauth");
    return response;
  }
}

export async function handleOAuthStatus(
  request: Request,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    now?: number;
    capabilitySummary?: (fingerprint: string, now?: number) => unknown;
  } = {},
): Promise<Response> {
  const config = getHiggsfieldOAuthConfig(options.env);
  if (!config) {
    return Response.json(
      { available: false, connected: false },
      { headers: NO_STORE_HEADERS },
    );
  }
  const original = readOAuthCookies(request);
  const status = await getHiggsfieldOAuthStatus({
    config,
    sessionCookies: original,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const headers = new Headers(NO_STORE_HEADERS);
  if (!status.connected) {
    clearAllOAuthCookies(headers);
    return Response.json(
      {
        available: true,
        connected: false,
        reconnectRequired: status.reconnectRequired,
        transport: "mcp_oauth",
      },
      { headers },
    );
  }
  const effective = status.sessionCookies ?? original;
  const session = readHiggsfieldOAuthSession(config, effective, options.now);
  if (!session) {
    clearAllOAuthCookies(headers);
    return Response.json(
      { available: true, connected: false, reconnectRequired: true, transport: "mcp_oauth" },
      { headers },
    );
  }
  if (status.sessionCookies) appendOAuthSessionCookies(headers, status.sessionCookies);
  const fingerprint = higgsfieldOAuthSessionFingerprint(session);
  return Response.json(
    {
      available: true,
      connected: true,
      transport: "mcp_oauth",
      ...(options.capabilitySummary
        ? { capability: options.capabilitySummary(fingerprint, options.now) }
        : {}),
    },
    { headers },
  );
}

export async function handleOAuthDisconnect(
  request: Request,
  options: {
    env?: NodeJS.ProcessEnv;
    clearRuntime?: (fingerprint: string) => void | Promise<void>;
  } = {},
): Promise<Response> {
  const config = getHiggsfieldOAuthConfig(options.env);
  if (config) {
    const crossSite = rejectCrossSiteMutation(request, config.publicOrigin);
    if (crossSite) return crossSite;
    const session = readHiggsfieldOAuthSession(config, readOAuthCookies(request));
    if (session && options.clearRuntime) {
      await options.clearRuntime(higgsfieldOAuthSessionFingerprint(session));
    }
  }
  const headers = new Headers(NO_STORE_HEADERS);
  clearAllOAuthCookies(headers);
  return Response.json({ connected: false, transport: "mcp_oauth" }, { headers });
}
