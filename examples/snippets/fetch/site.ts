// docs/bindings.md: a non-Effect caller (any bundled script or framework
// server) reading the binding its `env` map created.
import { edgeScriptFetcher } from "alchemy-bunny/EdgeScriptFetch";

const auth = edgeScriptFetcher("AUTH"); // AUTH_URL + AUTH_KEY

export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname.startsWith("/auth/") ? auth.fetch(request) : new Response("site"),
};
