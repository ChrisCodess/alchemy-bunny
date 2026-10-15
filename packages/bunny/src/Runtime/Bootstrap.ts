/**
 * Bootstrap for an Effect-native `Bunny.EdgeScript` — the counterpart of
 * `alchemy/Runtime/Bootstrap/Lambda`. The generated entry imports this
 * module and the user's `main`, nothing else:
 *
 * ```js
 * import { bootstrap } from "alchemy-bunny/Runtime/Bootstrap";
 * import entrypoint from "<main>";
 * bootstrap(entrypoint);
 * ```
 *
 * The instance-lifetime layers (Stack from `ALCHEMY_STACK_NAME` /
 * `ALCHEMY_STAGE`, an `HttpClient`, a `ConfigProvider` that reifies bound
 * values) are built once per isolate; each request gets its own scope from
 * the runtime context's `fetch` (see `EdgeScriptRuntime.ts`).
 */
import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { WebHandler } from "../EdgeScriptRuntime.ts";

// The pieces of `alchemy/Runtime/Bootstrap/Process` this bootstrap needs
// (that module's export ships TypeScript source, not declarations).

/** The tag every bundled platform program registers itself under (`Self`'s key). */
const entrypointTag = Context.Service<any, any>(Self.key);

/** `Stack` from the `ALCHEMY_STACK_NAME` / `ALCHEMY_STAGE` the provider injects. */
const stackFromEnv = Layer.effect(
  Stack,
  Effect.all([Config.String("ALCHEMY_STACK_NAME"), Config.String("ALCHEMY_STAGE")]).pipe(
    Effect.map(([name, stage]) => ({ name, stage, bindings: {}, resources: {}, actions: {} })),
  ),
);

export const bootstrap = (entrypoint: unknown): void => {
  const instanceScope = Scope.makeUnsafe();

  const layer = makeEntrypointLayer(entrypointTag, entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, Logger.layer([Logger.consolePretty()]))),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
  );

  const handler: Promise<WebHandler> = Effect.runPromise(
    Layer.buildWithScope(layer, instanceScope).pipe(
      Effect.flatMap((context) =>
        entrypointTag.pipe(
          Effect.flatMap((self: any) => self.RuntimeContext.exports as Effect.Effect<any>),
          Effect.flatMap((exports: { fetch: Effect.Effect<WebHandler> }) => exports.fetch),
          Effect.provideContext(context),
        ),
      ),
    ) as Effect.Effect<WebHandler>,
  );
  handler.catch((error) => console.error("[alchemy] Bunny Edge Script bootstrap failed:", error));

  // Edge Scripting needs the handler registered while the module loads.
  BunnySDK.net.http.serve(async (request) => (await handler)(request));
};
