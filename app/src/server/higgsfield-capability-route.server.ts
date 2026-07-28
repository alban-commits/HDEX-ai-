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
} from "./oauth-routes.server";
import { NO_STORE_HEADERS, rejectCrossSiteMutation } from "./http.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "./higgsfield-reconnect.server";

export async function handleHiggsfieldCapabilityInspection(request: Request): Promise<Response> {
  const active = await requireActiveOAuthSession(request);
  if (!active) {
    const headers = new Headers(NO_STORE_HEADERS);
    clearAllOAuthCookies(headers);
    return Response.json(
      { ok: false, reason: "oauth_required", reconnectRequired: true },
      { status: 401, headers },
    );
  }
  const crossSite = rejectCrossSiteMutation(request, active.config.publicOrigin);
  if (crossSite) return crossSite;
  const headers = new Headers(NO_STORE_HEADERS);
  if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
  const fingerprint = higgsfieldOAuthSessionFingerprint(active.session);
  try {
    await inspectHiggsfieldCapabilities({
      sessionFingerprint: fingerprint,
      mcpUrl: active.config.mcpUrl,
      accessToken: active.session.accessToken,
    });
    return Response.json(
      { ok: true, capability: getHiggsfieldCapabilitySummary(fingerprint) },
      { headers },
    );
  } catch (error) {
    if (isHiggsfieldAuthenticationFailure(error)) {
      await invalidateHiggsfieldAuthentication({ headers, sessionFingerprint: fingerprint });
      return Response.json(
        { ok: false, reason: "oauth_required", reconnectRequired: true },
        { status: 401, headers },
      );
    }
    const reason = error instanceof HiggsfieldMcpError ? error.reason : "provider_failure";
    return Response.json({ ok: false, reason }, { status: 502, headers });
  }
}
