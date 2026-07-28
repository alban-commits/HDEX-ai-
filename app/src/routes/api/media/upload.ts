import { createFileRoute } from "@tanstack/react-router";
import { handleHiggsfieldUpload } from "@/server/higgsfield-upload-route.server";

export const Route = createFileRoute("/api/media/upload")({
  server: {
    handlers: {
      POST: ({ request }) => handleHiggsfieldUpload(request),
    },
  },
});
