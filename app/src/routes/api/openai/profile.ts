import { createFileRoute } from "@tanstack/react-router";
import { handleOpenAiProfile } from "@/server/openai-profile-route.server";

export const Route = createFileRoute("/api/openai/profile")({
  server: { handlers: { POST: ({ request }) => handleOpenAiProfile(request) } },
});
