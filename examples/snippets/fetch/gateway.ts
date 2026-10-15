// docs/bindings.md: an Effect-native caller, through the FetchEdgeScript
// binding (Cloudflare.Workers.Fetch's shape).
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";
import Auth from "./auth.ts";

export default class Gateway extends Bunny.EdgeScript<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Effect.gen(function* () {
    const auth = yield* Bunny.FetchEdgeScript(yield* Auth);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The auth script sees this script's own URL (origin, path, query).
        const response = yield* auth(HttpClientRequest.get(request.url));
        return HttpServerResponse.fromClientResponse(response);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.FetchEdgeScriptHttp)),
) {}
