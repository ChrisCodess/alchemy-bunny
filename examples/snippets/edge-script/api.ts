// docs/edge-scripts.md: an Effect-native Edge Script. The init effect runs at
// deploy (collecting bindings) and again in the script.
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";

export default class Api extends Bunny.EdgeScript<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const greeting = yield* Config.String("GREETING"); // bound at deploy
    const signingKey = yield* (yield* Alchemy.Random("SigningKey")).text; // a generated secret
    return {
      fetch: Effect.gen(function* () {
        const key = yield* signingKey;
        return HttpServerResponse.text(`${greeting} (key: ${Redacted.value(key).length} chars)`);
      }),
    };
  }),
) {}
