import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Bunny from "alchemy-bunny";
import Api from "./api.ts";

export default Alchemy.Stack(
  "EdgeScripts",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const hello = yield* Bunny.EdgeScript("Hello", {
      main: "./hello.ts",
      env: { GREETING: "hello", API_TOKEN: Redacted.make("not-a-real-token") }, // Redacted → secret
    });
    const api = yield* Api;
    return { hello: hello.url, api: api.url };
  }),
);
