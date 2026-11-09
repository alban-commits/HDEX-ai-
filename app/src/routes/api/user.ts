import { createFileRoute } from "@tanstack/react-router";
import {
  appendOAuthSessionCookies,
  clearAllOAuthCookies,
  requireActiveOAuthSession,
} from "@/server/oauth-routes.server";
import { jsonNoStore } from "@/server/http.server";
import { higgsfieldOAuthSessionFingerprint } from "@/server/higgsfield-oauth.server";
import { verifyHiggsfieldMcpSession } from "@/server/higgsfield-mcp.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "@/server/higgsfield-reconnect.server";

export const Route = createFileRoute("/api/user")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const active = await requireActiveOAuthSession(request);
        if (!active) {
          return jsonNoStore({ error: "oauth_required" }, { status: 401 });
        }
        const headers = new Headers({ "Cache-Control": "no-store" });
        if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
        const fingerprint = higgsfieldOAuthSessionFingerprint(active.session);
        try {
          await verifyHiggsfieldMcpSession({
            sessionFingerprint: fingerprint,
            mcpUrl: active.config.mcpUrl,
            accessToken: active.session.accessToken,
          });
          return jsonNoStore({
            id: "higgsfield-oauth",
            workspaceId: "personal",
            ...(typeof active.session.accountEmail === "string"
              ? { accountEmail: active.session.accountEmail }
              : {}),
          }, { headers });
        } catch (error) {
          if (isHiggsfieldAuthenticationFailure(error)) {
            try {
              await invalidateHiggsfieldAuthentication({
                headers,
                sessionFingerprint: fingerprint,
              });
            } catch {
              clearAllOAuthCookies(headers);
            }
            return jsonNoStore({ error: "oauth_required" }, { status: 401, headers });
          }
          return jsonNoStore(
            { error: "higgsfield_connection_unverified" },
            { status: 424, headers },
          );
        }
      },
    },
  },
});
