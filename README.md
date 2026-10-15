# alchemy-bunny

A [bunny.net](https://bunny.net) provider for [Alchemy](https://alchemy.run) v2 — infrastructure as code in TypeScript, built on [Effect](https://effect.website).

- **Resources:** storage zones, pull zones (CDN), custom hostnames with free certificates, file sync, cache purge, edge rules, Edge Scripts, Bunny Database with SQL migrations, database tokens.
- **Edge Scripts as an Alchemy host**, like `Cloudflare.Worker`: a bundled file, or an Effect-native class whose init binds resources, config and secrets, and whose `fetch` serves requests.
- **Bindings** for Edge Scripts: read and write storage zones, query Bunny Databases, call one Edge Script from another like a service binding.
- **Websites:** `Website.StaticSite` and `Website.TanStackStart` (SSR and server functions on Edge Scripting).
- **Better Auth** on Bunny Database, the stock `@alchemy.run/better-auth` way.

```ts
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
      spa: true,
    });
    return { url: site.url };
  }),
);
```

```bash
bun add alchemy-bunny alchemy@2.0.0-beta.79 effect@4.0.0-rc.117 @effect/platform-bun@4.0.0-rc.117
BUNNY_API_KEY=... bun alchemy deploy
```

Read [Getting started](docs/getting-started.md) before the first deploy: Effect has to be pinned with overrides, and Actions (such as the Better Auth migration) need a one-line Alchemy patch on `2.0.0-beta.79`.

## Bindings in one example

An Edge Script with a storage zone and a database, bound the Alchemy way.

```ts
export const Uploads = Bunny.StorageZone("Uploads", {});
export const Db = Bunny.Database("Db", { migrations: "./migrations" });

export default class Api extends Bunny.EdgeScript<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Bunny.ReadWriteStorageZone(yield* Uploads);
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        yield* uploads.put("hello.txt", "hello");
        const row = yield* db.prepare("SELECT count(*) AS n FROM notes").first<{ n: number }>();
        return yield* HttpServerResponse.json({ notes: row?.n });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Bunny.ReadWriteStorageZoneHttp, Bunny.QueryDatabaseHttp))),
) {}
```

The zone's password and a database token reach the script as secrets; nothing is copied by hand. See [Bindings](docs/bindings.md).

## Imports

| Where | Import |
| --- | --- |
| The stack (`alchemy.run.ts`) and Effect-native Edge Scripts | `alchemy-bunny` |
| Better Auth's database layer | `alchemy-bunny/BetterAuth` |
| Plain code calling a bound Edge Script: a framework server or a bundled script | `alchemy-bunny/EdgeScriptFetch` |
| Plain code that wants a D1-style database (`drizzle-orm/d1`, …) | `alchemy-bunny/DatabaseD1` |

Plain runtime code never imports the package root; it would pull Alchemy and Effect into the bundle. Its values come from `env`, and the two subpaths above have no Alchemy or Effect dependencies. `alchemy-bunny-sdk` is installed with the package, as Alchemy's `@distilled.cloud/*` SDKs are installed with `alchemy`; apps never import it.

## Documentation

[Getting started](docs/getting-started.md) · [Resources](docs/resources.md) · [Edge Scripts](docs/edge-scripts.md) · [Bindings](docs/bindings.md) · [Bunny Database](docs/database.md) · [Websites](docs/websites.md) · [Better Auth](docs/better-auth.md) · [Local development](docs/local-development.md) · [SDK](docs/sdk.md) · [Known limitations](docs/limitations.md) · [bunny.net API notes](docs/bunny-net-notes.md)

## Packages

You install one package, [`alchemy-bunny`](packages/bunny). It depends on [`alchemy-bunny-sdk`](packages/bunny-sdk), the Effect client for the bunny.net APIs, which is internal in the way `@distilled.cloud/*` is internal to Alchemy ([details](docs/sdk.md)).

## Examples

| Example | |
| --- | --- |
| [`examples/static-site`](examples/static-site) | A static site, an Edge Script it calls, and a forced download |
| [`examples/tanstack-start`](examples/tanstack-start) | TanStack Start with SSR on Edge Scripting, a guestbook on Bunny Database, and Better Auth in its own Edge Script, bound into the site |
| [`examples/edge-api`](examples/edge-api) | A minimal Effect-native Edge Script |
| [`examples/snippets`](examples/snippets) | The code of the docs, typechecked |

## Status

`0.1.0`. It is built and tested against exact versions: `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117`, both pre-releases, so expect breaking changes as they move.

Every resource and binding is covered by lifecycle tests against a bunny.net stand-in. A live test suite runs against a real account. What has not been proven yet is listed in [Known limitations](docs/limitations.md). The most notable gap: database tokens cannot be revoked one at a time.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Portions are adapted from Alchemy (Apache-2.0); see [NOTICE](NOTICE). Not affiliated with bunny.net, Alchemy or Effect.
