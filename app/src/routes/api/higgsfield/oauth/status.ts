import { createFileRoute } from "@tanstack/react-router";
import { handleOAuthStatus } from "@/server/oauth-routes.server";
import { getHiggsfieldCapabilitySummary } from "@/server/higgsfield-mcp.server";

export const Route = createFileRoute("/api/higgsfield/oauth/status")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleOAuthStatus(request, { capabilitySummary: getHiggsfieldCapabilitySummary }),
    },
  },
});
