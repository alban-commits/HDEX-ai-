import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  beginHiggsfieldOAuth,
  completeHiggsfieldOAuth,
  getHiggsfieldOAuthStatus,
  readHiggsfieldOAuthSession,
  validateHiggsfieldOAuthCallbackState,
  type HiggsfieldOAuthConfig,
  type HiggsfieldOAuthCookieValues,
} from "../src/server/higgsfield-oauth.server";
import {
  handleOAuthConnect,
  handleOAuthCallback,
  handleOAuthDisconnect,
  handleOAuthStatus,
} from "../src/server/oauth-routes.server";

const NOW = Date.UTC(2026, 6, 27, 4, 0, 0);
const PUBLIC_ORIGIN = "https://hdex-ai.company.example";
const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const COOKIE_SECRET = Buffer.alloc(32, 7).toString("base64url");

const config: HiggsfieldOAuthConfig = {
  publicOrigin: PUBLIC_ORIGIN,
  callbackUrl: `${PUBLIC_ORIGIN}/api/higgsfield/oauth/callback`,
  mcpUrl: MCP_URL,
  cookieSecret: new Uint8Array(Buffer.from(COOKIE_SECRET, "base64url")),
};

const env = {
  HDEX_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  HDEX_HIGGSFIELD_MCP_URL: MCP_URL,
  HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET: COOKIE_SECRET,
} as NodeJS.ProcessEnv;

function discoveryFetch(options: {
  token?: Record<string, unknown>;
  tokenHook?: (body: URLSearchParams) => Promise<Response> | Response;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.toString() === MCP_URL && init?.method === "GET") {
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://mcp.higgsfield.ai/.well-known/oauth-protected-resource"',
        },
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: MCP_URL,
        authorization_servers: ["https://auth.higgsfield.ai"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.higgsfield.ai",
        authorization_endpoint: "https://auth.higgsfield.ai/authorize",
        token_endpoint: "https://auth.higgsfield.ai/token",
        registration_endpoint: "https://auth.higgsfield.ai/register",
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "offline_access"],
      });
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.redirect_uris).toEqual([config.callbackUrl]);
      expect(body.token_endpoint_auth_method).toBe("none");
      return Response.json({ client_id: "dynamic-client-id" });
    }
    if (url.pathname === "/token") {
      const body = init?.body as URLSearchParams;
      if (options.tokenHook) return options.tokenHook(body);
      return Response.json(
        options.token ?? {
          access_token: "personal-access-token",
          refresh_token: "personal-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        },
      );
    }
    throw new Error(`unexpected mock URL: ${url}`);
  };
}

async function connectedCookies(expiresIn = 3_600): Promise<{
  cookies: HiggsfieldOAuthCookieValues;
  authorizationUrl: URL;
}> {
  const started = await beginHiggsfieldOAuth(
    config,
    discoveryFetch({
      token: {
        access_token: "personal-access-token",
        refresh_token: "personal-refresh-token",
        token_type: "Bearer",
        expires_in: expiresIn,
      },
    }),
    NOW,
  );
  const authorizationUrl = new URL(started.authorizationUrl);
  const completed = await completeHiggsfieldOAuth({
    config,
    stateCookie: started.stateCookie,
    returnedState: authorizationUrl.searchParams.get("state"),
    code: "authorization-code",
    fetchImpl: discoveryFetch({
      token: {
        access_token: "personal-access-token",
        refresh_token: "personal-refresh-token",
        token_type: "Bearer",
        expires_in: expiresIn,
      },
    }),
    now: NOW,
  });
  return { cookies: completed.sessionCookies, authorizationUrl };
}

function cookieHeader(values: HiggsfieldOAuthCookieValues): string {
  return Object.entries({
    hdex_hf_oauth_session: values.session,
    hdex_hf_oauth_access: values.access,
    hdex_hf_oauth_refresh: values.refresh,
    hdex_hf_oauth_client: values.client,
  })
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

describe("Higgsfield OAuth security contract", () => {
  test("uses discovery, DCR, PKCE S256, resource binding, and sealed split cookies", async () => {
    const { cookies, authorizationUrl } = await connectedCookies();
    expect(authorizationUrl.origin).toBe("https://auth.higgsfield.ai");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const serialized = JSON.stringify(cookies);
    expect(serialized).not.toContain("personal-access-token");
    expect(serialized).not.toContain("personal-refresh-token");
    expect(new Set(Object.values(cookies)).size).toBe(4);
    expect(readHiggsfieldOAuthSession(config, cookies, NOW + 1_000)).toMatchObject({
      accessToken: "personal-access-token",
      refreshToken: "personal-refresh-token",
      clientId: "dynamic-client-id",
      resource: MCP_URL,
    });
  });

  test("rejects a mismatched or expired callback state before token exchange", async () => {
    const started = await beginHiggsfieldOAuth(config, discoveryFetch(), NOW);
    expect(() =>
      validateHiggsfieldOAuthCallbackState({
        config,
        stateCookie: started.stateCookie,
        returnedState: "wrong-state",
        now: NOW,
      }),
    ).toThrow("higgsfield_oauth_state_invalid");
    expect(() =>
      validateHiggsfieldOAuthCallbackState({
        config,
        stateCookie: started.stateCookie,
        returnedState: new URL(started.authorizationUrl).searchParams.get("state"),
        now: NOW + 11 * 60_000,
      }),
    ).toThrow("higgsfield_oauth_state_invalid");
  });

  test("coalesces concurrent access refreshes into one provider request", async () => {
    const { cookies } = await connectedCookies(120);
    let refreshCalls = 0;
    const refreshFetch: typeof fetch = async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("personal-refresh-token");
      refreshCalls += 1;
      await Promise.resolve();
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    };
    const [first, second] = await Promise.all([
      getHiggsfieldOAuthStatus({ config, sessionCookies: cookies, fetchImpl: refreshFetch, now: NOW }),
      getHiggsfieldOAuthStatus({ config, sessionCookies: cookies, fetchImpl: refreshFetch, now: NOW }),
    ]);
    expect(refreshCalls).toBe(1);
    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
    if (!first.connected || !first.sessionCookies) throw new Error("expected rotated cookies");
    expect(readHiggsfieldOAuthSession(config, first.sessionCookies, NOW)?.accessToken).toBe(
      "rotated-access-token",
    );
  });

  test("rejects split cookies mixed across two browser OAuth sessions", async () => {
    const first = await connectedCookies();
    const second = await connectedCookies();
    expect(
      readHiggsfieldOAuthSession(
        config,
        {
          session: first.cookies.session,
          access: second.cookies.access,
          refresh: first.cookies.refresh,
          client: first.cookies.client,
        },
        NOW + 1_000,
      ),
    ).toBeNull();
  });

  test("routes emit secure cookies, safe status JSON, reconnect state, and clear cookies", async () => {
    const connect = await handleOAuthConnect(
      new Request(
        `${PUBLIC_ORIGIN}/api/higgsfield/oauth/connect?return=${encodeURIComponent("/presets?tab=history#latest")}`,
      ),
      { env, fetchImpl: discoveryFetch(), now: NOW },
    );
    expect(connect.status).toBe(302);
    const stateHeader = connect.headers.get("set-cookie") ?? "";
    expect(stateHeader).toContain("HttpOnly");
    expect(stateHeader).toContain("Secure");
    expect(stateHeader).toContain("SameSite=Lax");
    expect(stateHeader).not.toContain("personal-access-token");
    const stateCookie = stateHeader.split(";", 1)[0]!;
    const authorization = new URL(connect.headers.get("location")!);
    const callback = await handleOAuthCallback(
      new Request(
        `${config.callbackUrl}?code=authorization-code&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
        { headers: { cookie: stateCookie } },
      ),
      { env, fetchImpl: discoveryFetch(), now: NOW },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${PUBLIC_ORIGIN}/presets?tab=history#latest`,
    );
    expect(callback.headers.get("location")).not.toMatch(/generate|submit|resume/);

    const { cookies } = await connectedCookies();
    const status = await handleOAuthStatus(
      new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/status`, {
        headers: { cookie: cookieHeader(cookies) },
      }),
      { env, now: NOW + 1_000 },
    );
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toMatchObject({
      available: true,
      connected: true,
      transport: "mcp_oauth",
    });
    expect(statusText).not.toMatch(/access-token|refresh-token|dynamic-client-id/);

    const expiring = await connectedCookies(120);
    const failedRefresh: typeof fetch = async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    const reconnect = await handleOAuthStatus(
      new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/status`, {
        headers: { cookie: cookieHeader(expiring.cookies) },
      }),
      { env, fetchImpl: failedRefresh, now: NOW },
    );
    expect(await reconnect.json()).toMatchObject({ connected: false, reconnectRequired: true });

    const disconnected = await handleOAuthDisconnect(
      new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/disconnect`, {
        method: "DELETE",
        headers: { origin: PUBLIC_ORIGIN, cookie: cookieHeader(cookies) },
      }),
      { env },
    );
    expect(disconnected.status).toBe(200);
    const cleared = disconnected.headers.get("set-cookie") ?? "";
    expect((cleared.match(/Max-Age=0/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(cleared).toContain("HttpOnly");
  });

  test("does not accept a public origin downgrade or an arbitrary MCP endpoint", async () => {
    const badOrigin = { ...env, HDEX_PUBLIC_ORIGIN: "http://hdex-ai.company.example" };
    const badMcp = { ...env, HDEX_HIGGSFIELD_MCP_URL: "https://example.com/mcp" };
    const [originResponse, mcpResponse] = await Promise.all([
      handleOAuthStatus(new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/status`), {
        env: badOrigin,
      }),
      handleOAuthStatus(new Request(`${PUBLIC_ORIGIN}/api/higgsfield/oauth/status`), {
        env: badMcp,
      }),
    ]);
    expect(await originResponse.json()).toEqual({ available: false, connected: false });
    expect(await mcpResponse.json()).toEqual({ available: false, connected: false });
    expect(createHash("sha256").update(COOKIE_SECRET).digest("hex")).toHaveLength(64);
  });
});
