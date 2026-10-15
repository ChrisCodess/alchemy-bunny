import { createFileRoute } from "@tanstack/react-router";
import { forwardToAuth } from "../../../auth-proxy.ts";

// Better Auth runs in its own Edge Script (auth/api.ts); the site forwards
// its endpoints so the browser stays on one origin.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => forwardToAuth(request),
      POST: ({ request }) => forwardToAuth(request),
    },
  },
});
