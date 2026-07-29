import { higgsfieldOAuthSessionFingerprint } from "./higgsfield-oauth.server";
import {
  getHiggsfieldCapabilitySummary,
  HiggsfieldMcpError,
  inspectHiggsfieldCapabilities,
} from "./higgsfield-mcp.server";
import {
  appendOAuthSessionCookies,
  clearAllOAuthCookies,
  requireActiveOAuthSession,
  type ActiveOAuthSession,
} from "./oauth-routes.server";
import { jsonNoStore, rejectCrossSiteMutation } from "./http.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "./higgsfield-reconnect.server";

type CapabilityStage = "session" | "origin" | "inspection" | "response";
type DependencyReason =
  | "timeout"
  | "authentication_failed"
  | "rate_limited"
  | "provider_failure"
  | "response_limit"
  | "invalid_response"
  | "capability_required";

const DEPENDENCY_REASONS = new Set<DependencyReason>([
  "timeout",
  "authentication_failed",
  "rate_limited",
  "provider_failure",
  "response_limit",
  "invalid_response",
  "capability_required",
]);

type CapabilityRouteOptions = {
  requireSession?: (request: Request) => Promise<ActiveOAuthSession | null>;
  inspectCapabilities?: typeof inspectHiggsfieldCapabilities;
  capabilitySummary?: typeof getHiggsfieldCapabilitySummary;
  invalidateAuthentication?: typeof invalidateHiggsfieldAuthentication;
  logDiagnostic?: (line: string) => void;
};

function dependencyReason(error: unknown): DependencyReason {
  return error instanceof HiggsfieldMcpError && DEPENDENCY_REASONS.has(error.reason)
    ? error.reason
    : "provider_failure";
}

export async function handleHiggsfieldCapabilityInspection(
  request: Request,
  options: CapabilityRouteOptions = {},
): Promise<Response> {
  const headers = new Headers();
  let stage: CapabilityStage = "session";
  let fingerprint: string | undefined;
  const respond = (body: unknown, status: number, reason: string): Response => {
    const response = jsonNoStore(body, { status, headers });
    try {
      (options.logDiagnostic ?? console.info)(
        JSON.stringify({ event: "higgsfield_capability_response", stage, status, reason }),
      );
    } catch {
      // Logging must never replace the bounded JSON API response.
    }
    return response;
  };

  try {
    const active = await (options.requireSession ?? requireActiveOAuthSession)(request);
    if (!active) {
      clearAllOAuthCookies(headers);
      return respond(
        { ok: false, reason: "oauth_required", reconnectRequired: true },
        401,
        "oauth_required",
      );
    }

    stage = "origin";
    const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
    if (crossSite) {
      return respond({ error: "invalid_origin" }, 403, "invalid_origin");
    }
    if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
    fingerprint = higgsfieldOAuthSessionFingerprint(active.session);

    stage = "inspection";
    await (options.inspectCapabilities ?? inspectHiggsfieldCapabilities)({
      sessionFingerprint: fingerprint,
      mcpUrl: active.config.mcpUrl,
      accessToken: active.session.accessToken,
    });

    stage = "response";
    const capability = (options.capabilitySummary ?? getHiggsfieldCapabilitySummary)(fingerprint);
    return respond({ ok: true, capability }, 200, "ok");
  } catch (error) {
    if (isHiggsfieldAuthenticationFailure(error)) {
      if (fingerprint) {
        try {
          await (options.invalidateAuthentication ?? invalidateHiggsfieldAuthentication)({
            headers,
            sessionFingerprint: fingerprint,
          });
        } catch {
          clearAllOAuthCookies(headers);
        }
      } else {
        clearAllOAuthCookies(headers);
      }
      return respond(
        { ok: false, reason: "oauth_required", reconnectRequired: true },
        401,
        "authentication_failed",
      );
    }
    const reason = dependencyReason(error);
    return respond({ ok: false, reason }, 424, reason);
  }
}
