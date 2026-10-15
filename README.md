# alchemy-bunny

A [bunny.net](https://bunny.net) provider for [Alchemy](https://alchemy.run) v2, the Effect-based infrastructure-as-code framework for TypeScript.

You install one package, `alchemy-bunny`. It depends on `alchemy-bunny-sdk`, an Effect client for the bunny.net APIs that the provider is built on. Apps never import the SDK, the same way Alchemy apps never import the `@distilled.cloud/*` SDKs behind `alchemy`.

What the provider covers:

- Alchemy resources for storage zones, pull zones, custom hostnames with free certificates, file sync, cache purge, edge rules, Edge Scripts, Bunny Database with SQL migrations, and database tokens.
- Edge Scripts as an Alchemy host, the way a Cloudflare Worker is one. A script is a bundled file, or an Effect-native class whose init binds resources, config and secrets and whose `fetch` serves requests.
- Bindings inside Edge Scripts to read and write storage zones, query Bunny Databases, and call one Edge Script from another.
- Two website composites, `Website.StaticSite` and `Website.TanStackStart`. The second runs SSR and server functions on Edge Scripting.
- Better Auth on Bunny Database, through the stock `@alchemy.run/better-auth` package.

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

Read [Getting started](docs/getting-started.md) before the first deploy. Effect has to be pinned with overrides, and Actions such as the Better Auth migration need a one-line Alchemy patch on `2.0.0-beta.79`.

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

The zone's password and a database token reach the script as secrets. Nothing is copied by hand. See [Bindings](docs/bindings.md).

## Imports

| Where | Import |
| --- | --- |
| The stack (`alchemy.run.ts`) and Effect-native Edge Scripts | `alchemy-bunny` |
| Better Auth's database layer | `alchemy-bunny/BetterAuth` |
| Plain code calling a bound Edge Script: a framework server or a bundled script | `alchemy-bunny/EdgeScriptFetch` |
| Plain code that wants a D1-style database (`drizzle-orm/d1`, …) | `alchemy-bunny/DatabaseD1` |

Plain runtime code never imports the package root, which would pull Alchemy and Effect into the bundle. Its values come from `env`, and the two subpaths above have no Alchemy or Effect dependencies.

## Documentation

[Getting started](docs/getting-started.md) · [Resources](docs/resources.md) · [Edge Scripts](docs/edge-scripts.md) · [Bindings](docs/bindings.md) · [Bunny Database](docs/database.md) · [Websites](docs/websites.md) · [Better Auth](docs/better-auth.md) · [Local development](docs/local-development.md) · [SDK](docs/sdk.md) · [Known limitations](docs/limitations.md) · [bunny.net API notes](docs/bunny-net-notes.md)

## Packages

The repository holds two packages.

- [`packages/bunny`](packages/bunny) is `alchemy-bunny`, the provider you install: resources, the Edge Script host, bindings, website composites, and the Better Auth layer.
- [`packages/bunny-sdk`](packages/bunny-sdk) is `alchemy-bunny-sdk`, the Effect client for the bunny.net APIs. It is installed as a dependency of the provider and needs only `effect`, so tooling that wants the raw API without Alchemy can use it on its own. See [the SDK](docs/sdk.md).

## Examples

| Example | |
| --- | --- |
| [`examples/static-site`](examples/static-site) | A static site, an Edge Script it calls, and a forced download |
| [`examples/tanstack-start`](examples/tanstack-start) | TanStack Start with SSR on Edge Scripting, a guestbook on Bunny Database, and Better Auth in its own Edge Script, bound into the site |
| [`examples/edge-api`](examples/edge-api) | A minimal Effect-native Edge Script |
| [`examples/snippets`](examples/snippets) | The code of the docs, typechecked |

## Status

Version `0.1.0`, built and tested against exact pre-release versions: `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117`. Expect breaking changes as they move. Every resource and binding has tests against a bunny.net stand-in, and a live suite runs against a real account.

Read these before you depend on the provider. The full list is in [Known limitations](docs/limitations.md).

- Bunny Database is in public preview: 50 databases per account, 1 GB per database, and bunny.net says its APIs may change.
- Database tokens cannot be revoked one at a time. Destroying a stack or replacing a token leaves the old JWT valid, and the token a binding issues never expires. See [Token revocation](docs/database.md#token-revocation).
- Alchemy state holds secrets: storage zone passwords, database tokens and generated keys. With `localState()` that is the `.alchemy/` directory. Protect the state store as you would a credential.
- bunny.net has no resource tags, so ownership lives in state alone. `alchemy nuke` cannot find bunny.net resources, an existing resource with an explicit `name` needs `--adopt`, and lost state means cleaning up by hand.
- A deleted storage zone's name stays blocked for an undocumented time, over 40 minutes in testing, so an explicitly named zone cannot be replaced. Generated names, the default, avoid the problem.
- There is no local emulator, so `alchemy dev` creates real resources in a dev stage and only framework dev servers run locally.
- Script-to-script calls go over public HTTPS with a shared key header, not a private binding. The callee must be an Effect-native script, and the key does not rotate on its own.
- Storage bodies are buffered, not streamed, under the 128 MB script memory limit.
- The default stage is `live_$USER`, and generated names put the stage into public `*.b-cdn.net` and `*.bunny.run` hostnames. Pass `--stage` to choose.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Portions are adapted from Alchemy (Apache-2.0); see [NOTICE](NOTICE). Not affiliated with bunny.net, Alchemy or Effect.
