import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";
import Auth from "./auth.ts";
import Gateway from "./gateway.ts";

export default Alchemy.Stack(
  "FetchExample",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const auth = yield* Auth;
    const gateway = yield* Gateway;
    // A plain script binds the callee through `env`, like a Cloudflare
    // service binding in an async Worker's `env`.
    const site = yield* Bunny.EdgeScript("Site", {
      main: "./site.ts",
      fetchHandler: true,
      env: { AUTH: auth },
    });
    return { gateway: gateway.url, site: site.url };
  }),
);
