import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";
import Files from "./files.ts";

export default Alchemy.Stack(
  "Files",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const files = yield* Files;
    return { url: files.url };
  }),
);
