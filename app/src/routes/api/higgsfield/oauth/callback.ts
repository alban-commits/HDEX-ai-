import { createFileRoute } from "@tanstack/react-router";
import { handleOAuthCallback } from "@/server/oauth-routes.server";

export const Route = createFileRoute("/api/higgsfield/oauth/callback")({
  server: { handlers: { GET: ({ request }) => handleOAuthCallback(request) } },
});
