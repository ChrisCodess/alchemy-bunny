// alchemy-bunny-sdk on its own: list storage zones, then read and write a
// file in one of them. Typechecked with the repository (docs/sdk.md).
import { Core, CredentialsFromEnv, Storage } from "alchemy-bunny-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const program = Effect.gen(function* () {
  // Core API, with the account key (BUNNY_API_KEY).
  const zones = yield* Core.listStorageZones({});
  const zone = zones.find((candidate) => candidate.Name === "my-zone");
  if (!zone?.Name || !zone.Password) return;

  // Edge Storage, with the zone's own password.
  const access: Storage.StorageZoneAccess = {
    hostname: zone.StorageHostname ?? "storage.bunnycdn.com",
    zoneName: zone.Name,
    // Sensitive fields arrive as `Redacted` (or a string from older responses).
    password: Redacted.isRedacted(zone.Password) ? zone.Password : Redacted.make(zone.Password),
  };
  yield* Storage.putObject(access, "hello.txt", new TextEncoder().encode("hello"));
  const file = yield* Storage.getFile(access, "hello.txt");
  console.log(file?.contentType, file?.body.byteLength);
});

program.pipe(Effect.provide(Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer)), Effect.runPromise);
