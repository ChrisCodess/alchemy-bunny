import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";

export default Alchemy.Stack(
  "BunnyStaticSite",
  {
    providers: Bunny.providers(),
    // Local state in .alchemy/. For a team or CI, use a remote store, e.g.
    // `Cloudflare.state()` from "alchemy/Cloudflare" (add Cloudflare.providers()).
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // An Edge Script with its own *.bunny.run hostname.
    const api = yield* Bunny.EdgeScript("Api", {
      main: "./edge/api.ts",
      env: { GREETING: "Hello from a bunny.net Edge Script, deployed with Alchemy" },
    });

    // The site: built with the script's URL, files synced to a storage zone,
    // a pull zone in front, asset cache rules, and forced downloads.
    const site = yield* Bunny.Website.StaticSite("Site", {
      command: "bun run build",
      outdir: "dist",
      env: { API_URL: api.url },
      downloads: "/downloads/*",
    });

    return {
      url: site.url,
      apiUrl: api.url,
      download: Output.interpolate`${site.url}/downloads/alchemy-on-bunny.txt`,
    };
  }),
);
