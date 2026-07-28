import { createFileRoute } from "@tanstack/react-router";
import { handleHiggsfieldResult } from "@/server/higgsfield-result-route.server";

export const Route = createFileRoute("/api/higgsfield/result/$jobId")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleHiggsfieldResult(request, params.jobId),
    },
  },
});
