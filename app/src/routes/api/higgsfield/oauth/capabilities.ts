import { createFileRoute } from "@tanstack/react-router";
import { handleHiggsfieldCapabilityInspection } from "@/server/higgsfield-capability-route.server";

export const Route = createFileRoute("/api/higgsfield/oauth/capabilities")({
  server: {
    handlers: { POST: ({ request }) => handleHiggsfieldCapabilityInspection(request) },
  },
});
