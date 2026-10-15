import * as Storage from "alchemy-bunny-sdk/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadStorageZone, type ReadStorageZoneClient } from "./ReadStorageZone.ts";
import { makeStorageZoneHttp, storageZoneHttpLayer, zoneKey, type StorageZoneHttp } from "./StorageZoneHttp.ts";

/**
 * Implementation of {@link ReadStorageZone} over the Edge Storage HTTP API,
 * with the zone's read-only password. Provide it on the host's
 * implementation.
 */
export const ReadStorageZoneHttp = Layer.effect(
  ReadStorageZone,
  Effect.suspend(() => makeStorageZoneHttp({ level: "Read", makeClient: makeReadStorageZoneClient })),
).pipe(Layer.provide(storageZoneHttpLayer));

/** Build the read client over a bound zone. */
export const makeReadStorageZoneClient = ({ run }: StorageZoneHttp): ReadStorageZoneClient => ({
  get: (key) =>
    run((access) => Storage.getFile(access, zoneKey(key))).pipe(Effect.map((file) => file ?? null)),
  list: (directory = "") => run((access) => Storage.listDirectory(access, zoneKey(directory))),
  listFiles: (prefix = "") => run((access) => Storage.listFiles(access, zoneKey(prefix))),
});
