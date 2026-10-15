// docs/bindings.md: the callee — an Effect-native Edge Script. Its runtime
// handles a keyed request from a bound caller as the URL the caller
// addressed.
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";

export default class Auth extends Bunny.EdgeScript<Auth>()(
  "Auth",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* HttpServerResponse.json({ handledAs: request.url });
      }),
    };
  }),
) {}
