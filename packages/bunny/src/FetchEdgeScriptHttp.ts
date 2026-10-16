import * as Binding from "alchemy/Binding";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { EdgeScript } from "./EdgeScript.ts";
import { FETCH_KEY_ENV, toForwardedRequest } from "./EdgeScriptFetch.ts";
import { fetchKeyOf } from "./EdgeScriptFetchKey.ts";
import { FetchEdgeScript } from "./FetchEdgeScript.ts";

const isAbsolute = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

/**
 * Implementation of {@link FetchEdgeScript} over HTTPS (bunny.net has no
 * service bindings). The callee's key is an `Alchemy.Random` per callee,
 * shared by every caller: binding binds it onto the callee as
 * `ALCHEMY_FETCH_KEY` (its Binding Contract) and yields it, with the
 * callee's `url`, into the caller.
 */
export const FetchEdgeScriptHttp = Layer.effect(
  FetchEdgeScript,
  Effect.gen(function* () {
    const Key = yield* Random;
    return Effect.fn(function* (script: EdgeScript) {
      const key = yield* fetchKeyOf((id) => Key(id), script);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined) {
          yield* script.bind(`${FETCH_KEY_ENV}:${host.LogicalId}`, { env: { [FETCH_KEY_ENV]: key.text } });
        }
      }
      // Yielding an Output binds it into the caller (plan) and returns its
      // runtime accessor.
      const url = yield* script.url;
      const secret = yield* key.text;
      return (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const base = yield* url;
          const value = yield* secret;
          if (base === undefined || value === undefined) {
            return yield* Effect.die(
              new Error("FetchEdgeScript binding is missing the callee's url or key; is FetchEdgeScriptHttp provided on this host?"),
            );
          }
          const absolute = isAbsolute(request.url)
            ? request
            : HttpClientRequest.setUrl(request, new URL(request.url, base).href);
          const web = yield* HttpClientRequest.toWeb(absolute).pipe(
            Effect.mapError(
              (cause) => new HttpClientError.InvalidUrlError({ request, cause, description: "Failed to construct URL" }),
            ),
          );
          const forwarded = toForwardedRequest(web, undefined, { url: base, key: Redacted.value(value) });
          const response = yield* Effect.tryPromise({
            try: (signal) => fetch(forwarded, { signal }),
            catch: (cause) =>
              new HttpClientError.TransportError({ request, cause, description: "Edge Script fetch failed" }),
          });
          return HttpClientResponse.fromWeb(request, response);
        });
    });
  }),
);
