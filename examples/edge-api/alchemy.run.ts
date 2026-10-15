import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "BunnyEdgeApi",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
