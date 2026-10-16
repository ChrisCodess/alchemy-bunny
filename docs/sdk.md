# The internal SDK

`alchemy-bunny-sdk` is the Effect client for the bunny.net APIs that `alchemy-bunny` is built on. It is installed with the provider and apps do not import it, just as Alchemy apps never import the `@distilled.cloud/*` SDKs behind `alchemy`. This page is for contributors, and for tooling that wants the raw API without Alchemy (it needs only `effect`).

| Export | What it covers |
| --- | --- |
| `Core` | Core API (`https://api.bunny.net`): storage zones, pull zones, hostnames, edge rules, purge, DNS zones, … (generated) |
| `Compute` | Edge Scripting: scripts, code, releases, variables, secrets (generated) |
| `Database` | Bunny Database management (`/database`, v2): databases, regions, tokens, revoke (generated) |
| `Storage` | Edge Storage file API (hand-written): `getFile`, `getObject`, `putObject`, `deleteObject`, `listDirectory`, `listFiles` |
| `Sql` | Bunny Database SQL over Hrana (`/v2/pipeline`) (hand-written) |
| `checksumOf` | uppercase hex SHA-256, the format of the storage `Checksum` header |
| `Credentials`, `CredentialsFromEnv`, `fromApiKey` | the account key for `Core`, `Compute` and `Database` |

```ts
import { Core, CredentialsFromEnv, Storage } from "alchemy-bunny-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const zones = yield* Core.listStorageZones({});
  const zone = zones.find((candidate) => candidate.Name === "my-zone");
  if (!zone?.Name || !zone.Password) return;

  // Edge Storage takes the zone's own password, not the account key.
  const access: Storage.StorageZoneAccess = {
    hostname: zone.StorageHostname ?? "storage.bunnycdn.com",
    zoneName: zone.Name,
    password: Redacted.isRedacted(zone.Password) ? zone.Password : Redacted.make(zone.Password),
  };
  yield* Storage.putObject(access, "hello.txt", new TextEncoder().encode("hello"));
  const file = yield* Storage.getFile(access, "hello.txt");
});

program.pipe(Effect.provide(Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer)), Effect.runPromise);
```

- Failures are tagged: `NotFound`, `NameTaken`, `NameBeingDeleted`, `Storage*`, `Sql*`, `UnknownBunnyError` for anything unexpected, and `BunnyParseError` when strict response validation (`ResponseValidation.strict` from `@distilled.cloud/core`) rejects a 2xx body.
- Throttling and 5xx responses are retried with backoff; the `Sql` module also retries the database's transient 421.
- Sensitive fields (passwords, tokens, keys) are marked in the generated schemas and come back as `Redacted`.
- List operations are paginated streams: `Core.listDnsZones.items({})` is a `Stream`.
- `Storage` and `Sql` import no Node builtins, so they bundle into Edge Scripts. `checksumOf` lives in its own module because it needs `node:crypto`.

## How the generated modules are made

`src/services/*` are generated from the OpenAPI documents bunny.net publishes, with Alchemy's [distilled](https://github.com/alchemy-run/distilled) generator:

```bash
cd packages/bunny-sdk
bun run fetch-specs   # download the OpenAPI documents into specs/
bun run convert       # specs + patches/ → .generated-specs/
bun run generate      # .generated-specs → src/services/
```

Spec defects are fixed with RFC-6902 patches in `patches/<spec>/`, never by editing generated files. Each patch says why it exists. Current patches cover:
- missing create response bodies;
- the two pull zone list shapes;
- a typed `NameTaken` error;
- pagination;
- a phantom path parameter;
- for the database API: the token marked sensitive, undeclared 404 and 400 responses, and deprecated fields listed as required.

The Edge Storage API has no usable OpenAPI document: it lacks operation ids and listing `Checksum`s, and gives the wrong New York host. So `Storage` is hand-written, following bunny.net's HTTP docs and its official storage SDK.
