import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EdgeScript } from "../../src/EdgeScript.ts";
import { FetchEdgeScript } from "../../src/FetchEdgeScript.ts";
import { FetchEdgeScriptHttp } from "../../src/FetchEdgeScriptHttp.ts";
import Callee from "./callee.ts";

/** Calls `Callee` through the `FetchEdgeScript` binding. */
export default class Caller extends EdgeScript<Caller>()(
  "Caller",
  { main: import.meta.url },
  Effect.gen(function* () {
    const callee = yield* FetchEdgeScript(yield* Callee);
    return {
      fetch: Effect.gen(function* () {
        const response = yield* callee(HttpClientRequest.get("https://example.com/hello?x=1"));
        return HttpServerResponse.fromClientResponse(response);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(FetchEdgeScriptHttp)),
) {}
