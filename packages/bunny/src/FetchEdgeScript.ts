import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { EdgeScript } from "./EdgeScript.ts";

/**
 * Bind a standalone {@link EdgeScript} and call it — the Bunny counterpart
 * of `Cloudflare.Workers.Fetch` (a service binding), usable from a
 * `Bunny.EdgeScript` or any other Alchemy host with a runtime context.
 *
 * The callee handles each request as the URL it was addressed to, as with a
 * service binding: a caller forwarding a browser request passes the
 * browser's URL, and the callee sees that origin, path and cookies. bunny.net
 * has no service bindings, so the call goes over HTTPS to the callee's
 * `url` with the original URL and a key the callee checks (see
 * `EdgeScriptFetch.ts`); the callee must be an Effect-native
 * `Bunny.EdgeScript`, whose runtime does the check. Redirects are returned,
 * not followed.
 *
 * Provide {@link FetchEdgeScriptHttp} on the caller's implementation:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const auth = yield* Bunny.FetchEdgeScript(AuthApi);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const request = yield* HttpServerRequest.HttpServerRequest;
 *       const response = yield* auth(HttpClientRequest.get(`${publicOrigin}/api/auth/get-session`));
 *       return HttpServerResponse.fromClientResponse(response);
 *     }),
 *   };
 * }).pipe(Effect.provide(Bunny.FetchEdgeScriptHttp))
 * ```
 *
 * @binding
 */
export interface FetchEdgeScript extends Binding.Service<
  FetchEdgeScript,
  "Bunny.FetchEdgeScript",
  (
    script: EdgeScript,
  ) => Effect.Effect<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.RequestError, RuntimeContext>
  >
> {}

export const FetchEdgeScript = Binding.Service<FetchEdgeScript>("Bunny.FetchEdgeScript");
