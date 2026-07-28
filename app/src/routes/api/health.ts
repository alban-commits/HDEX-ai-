import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeReadiness } from "@/server/runtime-config.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const readiness = getRuntimeReadiness();
        return Response.json(
          {
            status: readiness.ready ? "ok" : "degraded",
            service: "hdex-influencer-frame",
            runtime: "node",
            checks: readiness.checks,
          },
          {
            status: readiness.ready ? 200 : 503,
            headers: { "Cache-Control": "no-store" },
          },
        );
      },
    },
  },
});
