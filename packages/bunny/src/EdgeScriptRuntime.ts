/**
 * The runtime context of an Effect-native `Bunny.EdgeScript` — the Bunny
 * counterpart of `AWS.Lambda.Function`'s and `Cloudflare.Worker`'s.
 *
 * - `set` (plan): binds an Output into the script's env. `Redacted` values
 *   stay `Redacted` (marker-packed inside), so `EdgeScript` deploys them as
 *   secrets rather than plain variables.
 * - `get` (runtime): reads the bound value back from `process.env`.
 * - `serve`: stores the `fetch` handler; `exports.fetch` turns it into a
 *   web `(Request) => Promise<Response>` with a fresh request scope per
 *   request, which the bootstrap hands to `BunnySDK.net.http.serve`. A
 *   request from a bound caller (`Bunny.FetchEdgeScript`, or an `env`
 *   binding) carrying this script's `ALCHEMY_FETCH_KEY` is handled as the
 *   URL the caller addressed, like a Cloudflare service binding call (see
 *   `EdgeScriptFetch.ts`).
 */
import type { HttpEffect } from "alchemy/Http";
import * as Http from "alchemy/Http";
import * as Output from "alchemy/Output";
import {
  packEnvValueKeepRedacted,
  unpackEnvValue,
  type BaseRuntimeContext,
} from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { FETCH_KEY_ENV, fromForwardedRequest } from "./EdgeScriptFetch.ts";

export const EDGE_SCRIPT_TYPE = "Bunny.EdgeScript";

export type WebHandler = (request: Request) => Promise<Response>;

export interface EdgeScriptContext extends BaseRuntimeContext {
  serve<Req = never>(
    handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  exports: Effect.Effect<{ readonly fetch: Effect.Effect<WebHandler> }>;
}

export const makeEdgeScriptRuntimeContext = (id: string): EdgeScriptContext => {
  const env: Record<string, any> = {};
  let handler: HttpEffect<any> | Effect.Effect<HttpEffect<any>> | undefined;

  const fetch = Effect.gen(function* () {
    // Instance-lifetime services (what init saw); the memo map is dropped
    // so a Layer provided inside a handler builds per request.
    const services = Context.omit(Layer.CurrentMemoMap)(yield* Effect.context<never>());
    const safeHandler = HttpMiddleware.tracer(
      Http.safeHttpEffect(
        handler ?? Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
      ),
    );
    return (async (incoming: Request) => {
      const request = fromForwardedRequest(incoming, process.env[FETCH_KEY_ENV]);
      const scope = Scope.makeUnsafe();
      const effect = safeHandler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request).modify({ url: request.url }),
        ),
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.provideService(Scope.Scope, scope),
        Effect.provideContext(services),
      ) as Effect.Effect<Response>;
      const exit = await Effect.runPromiseExit(effect);
      if (!Http.isScopeEjected(scope)) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      return Exit.isSuccess(exit) ? exit.value : new Response("Internal Server Error", { status: 500 });
    }) satisfies WebHandler;
  });

  return {
    Type: EDGE_SCRIPT_TYPE,
    id,
    env,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
    serve: ((next: HttpEffect<any> | Effect.Effect<HttpEffect<any>>) =>
      Effect.sync(() => {
        handler = next;
      })) as EdgeScriptContext["serve"],
    exports: Effect.sync(() => ({ fetch })),
  } satisfies EdgeScriptContext;
};
