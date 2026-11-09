import { createFileRoute } from "@tanstack/react-router";
import { handleOAuthConnect } from "@/server/oauth-routes.server";
import { higgsfieldOAuthSessionFingerprint } from "@/server/higgsfield-oauth.server";
import { verifyHiggsfieldMcpSession } from "@/server/higgsfield-mcp.server";

const verifySession = (session: Parameters<typeof higgsfieldOAuthSessionFingerprint>[0]) =>
  verifyHiggsfieldMcpSession({
    sessionFingerprint: higgsfieldOAuthSessionFingerprint(session),
    mcpUrl: session.resource,
    accessToken: session.accessToken,
  });

export const Route = createFileRoute("/api/higgsfield/oauth/connect")({
  server: { handlers: { GET: ({ request }) => handleOAuthConnect(request, { verifySession }) } },
});
