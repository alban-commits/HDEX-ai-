import { createFileRoute } from "@tanstack/react-router";
import { handleOAuthDisconnect } from "@/server/oauth-routes.server";
import { clearHiggsfieldRuntime } from "@/server/higgsfield-mcp.server";
import { clearGenerationRuntime } from "@/server/higgsfield-generation-adapter.server";

async function clearOAuthRuntime(sessionFingerprint: string): Promise<void> {
  clearHiggsfieldRuntime(sessionFingerprint);
  await clearGenerationRuntime(sessionFingerprint);
}

export const Route = createFileRoute("/api/higgsfield/oauth/disconnect")({
  server: {
    handlers: {
      DELETE: ({ request }) => handleOAuthDisconnect(request, { clearRuntime: clearOAuthRuntime }),
    },
  },
});
