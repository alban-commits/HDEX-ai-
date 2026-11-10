import { createFileRoute } from "@tanstack/react-router";
import { appendOAuthSessionCookies, requireActiveOAuthSession } from "@/server/oauth-routes.server";

export const Route = createFileRoute("/api/user")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const active = await requireActiveOAuthSession(request);
        if (!active) {
          return Response.json({ error: "oauth_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
        }
        const headers = new Headers({ "Cache-Control": "no-store" });
        if (active.rotatedCookies) appendOAuthSessionCookies(headers, active.rotatedCookies);
        return Response.json({ id: "higgsfield-oauth", workspaceId: "personal" }, { headers });
      },
    },
  },
});
