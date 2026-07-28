import { createFileRoute } from "@tanstack/react-router";
import { handleOAuthConnect } from "@/server/oauth-routes.server";

export const Route = createFileRoute("/api/higgsfield/oauth/connect")({
  server: { handlers: { GET: ({ request }) => handleOAuthConnect(request) } },
});
