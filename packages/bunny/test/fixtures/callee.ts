import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { EdgeScript } from "../../src/EdgeScript.ts";

/** Answers with the URL it handled. */
export default class Callee extends EdgeScript<Callee>()(
  "Callee",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* HttpServerResponse.json({ url: request.url });
      }),
    };
  }),
) {}
