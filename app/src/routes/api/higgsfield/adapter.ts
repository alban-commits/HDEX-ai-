import { createFileRoute } from "@tanstack/react-router";
import { handleHiggsfieldAdapter } from "@/server/higgsfield-adapter-route.server";

export const Route = createFileRoute("/api/higgsfield/adapter")({
  server: { handlers: { POST: ({ request }) => handleHiggsfieldAdapter(request) } },
});
