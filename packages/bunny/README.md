# alchemy-bunny

A [bunny.net](https://bunny.net) provider for [Alchemy](https://alchemy.run) v2 (Effect-based infrastructure as code).

- Alchemy resources for storage zones, pull zones (CDN), custom hostnames with free certificates, file sync, cache purge, edge rules, Edge Scripts, Bunny Database with SQL migrations, database tokens.
- Edge Scripts as an Alchemy host, the way a Cloudflare Worker is one: an Effect-native class whose init binds resources, config and secrets, and whose `fetch` serves requests.
- Bindings (Alchemy capabilities) for Edge Scripts: `ReadStorageZone` / `WriteStorageZone` / `ReadWriteStorageZone`, `QueryDatabase`, `FetchEdgeScript`.
- Two website composites, `Website.StaticSite` and `Website.TanStackStart` (SSR on Edge Scripting).
- Better Auth on Bunny Database: `BunnyDatabase` for `@alchemy.run/better-auth`.

```bash
bun add alchemy-bunny alchemy@2.0.0-beta.79 effect@4.0.0-rc.117 @effect/platform-bun@4.0.0-rc.117
```

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";

export default Alchemy.Stack(
  "MySite",
  { providers: Bunny.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Bunny.Website.StaticSite("Site", { command: "bun run build", outdir: "dist", spa: true });
    return { url: site.url };
  }),
);
```

```bash
BUNNY_API_KEY=... bun alchemy deploy
```

Import the root in the stack and in Effect-native scripts; plain runtime code uses `alchemy-bunny/EdgeScriptFetch` and `/DatabaseD1`, which have no Alchemy or Effect dependencies. The `alchemy-bunny-sdk` dependency is internal.

`alchemy` and `effect` are exact peer versions: this release is built and tested against `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117`. Read [Installation](https://github.com/ChrisCodess/alchemy-bunny/blob/main/docs/getting-started.md#installation) before using Better Auth migrations: `alchemy@2.0.0-beta.79` needs a one-line patch.

**Documentation:** [github.com/ChrisCodess/alchemy-bunny/tree/main/docs](https://github.com/ChrisCodess/alchemy-bunny/tree/main/docs) · **Known limitations:** [docs/limitations.md](https://github.com/ChrisCodess/alchemy-bunny/blob/main/docs/limitations.md)

Apache-2.0. Not affiliated with bunny.net or Alchemy.
