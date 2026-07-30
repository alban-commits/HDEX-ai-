import { createFileRoute } from "@tanstack/react-router";
import { handleHorizonPrompt } from "@/server/horizon-prompt-route.server";

export const Route = createFileRoute("/api/openai/horizon")({
  server: { handlers: { POST: ({ request }) => handleHorizonPrompt(request) } },
});
