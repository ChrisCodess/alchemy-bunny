import * as Bunny from "alchemy-bunny";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * An Effect-native Edge Script, declared like a `Cloudflare.Worker`: the init
 * effect binds a config value and a generated secret into the script's env
 * at deploy time and reads them back at runtime.
 */
export default class Api extends Bunny.EdgeScript<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const greeting = yield* Config.String("GREETING").pipe(Config.withDefault("Hello from an Effect-native Edge Script"));
    const signingKey = yield* (yield* Alchemy.Random("SigningKey")).text;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = yield* signingKey;
        return yield* HttpServerResponse.json({
          greeting,
          path: new URL(request.url, "http://localhost").pathname,
          signingKeyLength: Redacted.value(key).length,
        });
      }),
    };
  }),
) {}
