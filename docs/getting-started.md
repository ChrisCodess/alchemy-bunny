# Getting started

## Installation

```bash
bun add alchemy-bunny alchemy@2.0.0-beta.83 effect@4.0.5 @effect/platform-bun@4.0.5
```

`alchemy` is a peer dependency pinned to the exact beta this release is built and tested with. `effect` is a peer at `^4.0.0`, tested with `4.0.5`. The Alchemy CLI also needs `@effect/platform-bun` in your project.

The `@alchemy.run/better-auth`, `better-auth` and `kysely` peers are optional; install them only for the [Better Auth](better-auth.md) layer. `Website.TanStackStart` also needs `@alchemy.run/frontend-frameworks@2.0.0-beta.83`.

## Imports

| Where | Import |
| --- | --- |
| The stack (`alchemy.run.ts`) and Effect-native Edge Scripts | `alchemy-bunny` |
| Better Auth's database layer | `alchemy-bunny/BetterAuth` |
| Plain code calling a bound Edge Script: a framework server or a bundled script | `alchemy-bunny/EdgeScriptFetch` |
| Plain code that wants a D1-style database (`drizzle-orm/d1`, …) | `alchemy-bunny/DatabaseD1` |

Plain runtime code never imports the package root; it would pull Alchemy and Effect into the bundle. Its values come from `env`, and the two subpaths above have no Alchemy or Effect dependencies. `alchemy-bunny-sdk` is installed with the package, as Alchemy's `@distilled.cloud/*` SDKs are installed with `alchemy`; apps never import it.

## Credentials

Create an account API key in the bunny.net dashboard (Account → API) and export it:

```bash
export BUNNY_API_KEY=...   # or put it in a gitignored .env; Bun loads it
```

`BUNNY_API_BASE_URL` overrides the API endpoint (default `https://api.bunny.net`). The provider is also registered with Alchemy's profiles (`alchemy profile edit`), but only the environment variable has been used in testing so far.

The key never reaches deployed code. Resources that need a narrower credential create one (storage zone passwords, database tokens; see [Bindings](bindings.md)).

## A first stack

```ts
// alchemy.run.ts
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
```

```bash
bun alchemy deploy     # prints https://<name>.b-cdn.net
bun alchemy destroy
```

`Bunny.providers()` registers every bunny.net resource provider plus `Alchemy.Random`, `Website.Server` and the `Command` providers. To use bunny.net next to another cloud, merge the layers: `providers: Layer.mergeAll(Cloudflare.providers(), Bunny.providers())`.

## State and stages

State lives in `.alchemy/` with `Alchemy.localState()`; use a remote store (for example `Cloudflare.state()`) for a team or CI. `alchemy deploy` targets the stage `live_$USER` by default and `alchemy dev` the stage `dev_$USER`; pass `--stage` to choose.

bunny.net has no resource tags, so `alchemy nuke` cannot list bunny.net resources, and an existing resource with an explicit `name` is reported as not owned by the stack (deploy with `--adopt` to take it over). Generated names are the default and avoid both.

## Next

- [Resources](resources.md): every resource and what replaces it
- [Edge Scripts](edge-scripts.md): bundled and Effect-native scripts
- [Bindings](bindings.md): storage, database and script-to-script access from scripts
- [Examples](../examples): a static site, a TanStack Start app with Better Auth, an Effect-native API
