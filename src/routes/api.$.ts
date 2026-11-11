import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/server/controllers/router";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleApi(request),
      POST: ({ request }) => handleApi(request),
      PATCH: ({ request }) => handleApi(request),
      PUT: ({ request }) => handleApi(request),
      DELETE: ({ request }) => handleApi(request),
    },
  },
});
