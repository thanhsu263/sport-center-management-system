import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/arena3/router";

export const Route = createFileRoute("/v1/$")({
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
