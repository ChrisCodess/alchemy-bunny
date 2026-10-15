// README quick start: a static site on bunny.net.
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";

export default Alchemy.Stack(
  "MySite",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Bunny.Website.StaticSite("Site", {
      command: "bun run build",
      outdir: "dist",
      spa: true, // unknown paths serve /index.html
    });
    return { url: site.url };
  }),
);
