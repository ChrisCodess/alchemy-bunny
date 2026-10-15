# Contributing

## Setup

```bash
bun install
bun run typecheck    # the whole workspace, from sources; no build needed
bun test             # unit tests and provider lifecycle tests against a bunny.net stand-in
bun run build        # emit packages/*/lib (JavaScript + declarations)
bun run pack         # build, pack both packages into release-packages/, validate the tarballs
```

This repository uses [Bun](https://bun.sh) for everything: `bun install`, `bun test`, `bun run`, `bunx`.

## Layout

| Path | |
| --- | --- |
| `packages/bunny-sdk` | `alchemy-bunny-sdk`. `src/services/*` and `.generated-specs/` are **generated**. Fix spec problems with a patch in `patches/<spec>/`, never by editing generated files. `storage.ts`, `sql.ts` and the other `src/*.ts` are hand-written. |
| `packages/bunny` | `alchemy-bunny`: resources, providers, capabilities, websites, Better Auth layer |
| `examples/*` | Runnable stacks; `examples/snippets` holds the code of `docs/`, typechecked but never deployed |
| `docs/` | User documentation |
| `patches/` | `alchemy@2.0.0-beta.79.patch`, a backport from Alchemy `main` (see [Getting started](docs/getting-started.md#installation)). Remove it when upgrading to an Alchemy release that contains the fix. |

## Conventions

The provider follows [Alchemy's](https://github.com/alchemy-run/alchemy) own resource conventions (its `AGENTS.md`):
- reconcilers that observe → ensure → sync;
- typed error tags;
- `Effect.fn`;
- never `Effect.orDie` in lifecycle operations;
- Effect platform services instead of `node:fs` / `async`.

When Alchemy has a convention, use it rather than inventing one, and name the reference in the code or PR.

- **Resources** declare their contract and provider together, except `EdgeScript`. `EdgeScript.ts` is the declaration, `EdgeScriptProvider.ts` the provider (it imports rolldown), `EdgeScriptRuntime.ts` the runtime context and `Runtime/Bootstrap.ts` the bootstrap. Both packages are `"sideEffects": false`. Keep declarations free of provider imports, or provider code leaks into Edge Script and Worker bundles.
- **Capabilities** are `Binding.Service`s laid out like the installed `alchemy/Cloudflare/R2` (`ReadBucket.ts` + `ReadBucketHttp.ts`, shared scaffolding un-exported) and `Cloudflare/D1` (`QueryDatabase` + `QueryDatabaseLocal`).
  - bunny.net has no native bindings, so, like Alchemy's Stripe and Prisma capabilities, they **yield resource Outputs** (`RuntimeContext.set`) instead of calling `host.bind`.
  - Credentials derive their logical ID from the bound resource, not the host.
  - Capability modules and `EdgeScriptFetch.ts` are bundled into Edge Scripts: no provider imports, no `node:crypto`.
- **Website composites** follow Alchemy's (`Fly.Website.*`, `Cloudflare.Website.*`): build and dev through `alchemy/Website/Server`, a stock `vite.config.ts`, one `env` map. No bunny.net-specific Vite plugins.
- **Versions are pinned exactly**: `alchemy@2.0.0-beta.79`, `effect@4.0.0-rc.117`, `@distilled.cloud/core@1.0.0-rc.12`, `better-auth@1.7.6`, `@alchemy.run/better-auth@2.0.0-beta.79`, `@alchemy.run/frontend-frameworks@2.0.0-beta.79`. Upgrade `effect` only together with Alchemy.
- **Never guess bunny.net behaviour.** Verify it against the live API and record it in [docs/bunny-net-notes.md](docs/bunny-net-notes.md). Then calibrate the stand-in (`packages/bunny/test/mock-bunny.ts`) to it.

## Tests

- `bun test` runs the SDK unit tests, the capability clients (`packages/bunny/test/capabilities.test.ts`) and the provider lifecycle tests (`provider.test.ts`). The lifecycle tests run the real Alchemy engine against `mock-bunny.ts`. They prove the provider logic, not that bunny.net behaves like the stand-in.
- The live suite runs against a real account. It creates and destroys throwaway zones, scripts and databases (a few KB of storage and traffic for a few minutes):

  ```bash
  BUNNY_LIVE=1 BUNNY_API_KEY=... bun test packages/bunny/test/live.test.ts
  ```

Editor TypeScript diagnostics can go stale after `bun install` relinks packages; the CLI (`bun run typecheck`) is authoritative.

## Regenerating the SDK

```bash
cd packages/bunny-sdk
bun run fetch-specs   # bunny.net's OpenAPI documents → specs/
bun run convert       # specs + patches/ → .generated-specs/
bun run generate      # .generated-specs → src/services/
```

## Releasing

Both packages share one version and are published to the public npm registry.
1. Update `CHANGELOG.md` and both `version` fields.
2. Run `bun run pack`. It builds, packs and checks the tarballs: metadata, the package names, no `workspace:` ranges, `lib/` and `src/` present, no tests or specs. Tarballs land in `release-packages/`.
3. Publish the SDK first, since the provider depends on it. This needs an npm account with publish rights (`npm login` once):

   ```bash
   npm publish ./release-packages/alchemy-bunny-sdk-<version>.tgz
   npm publish ./release-packages/alchemy-bunny-<version>.tgz
   ```

   Keep the `./`: without it npm reads `release-packages/…` as a GitHub `owner/repo` shorthand.
