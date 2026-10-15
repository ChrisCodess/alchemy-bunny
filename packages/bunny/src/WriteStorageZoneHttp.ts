import * as Storage from "alchemy-bunny-sdk/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeStorageZoneHttp, storageZoneHttpLayer, zoneKey, type StorageZoneHttp } from "./StorageZoneHttp.ts";
import { WriteStorageZone, type WriteStorageZoneClient } from "./WriteStorageZone.ts";

/**
 * Implementation of {@link WriteStorageZone} over the Edge Storage HTTP API,
 * with the zone's password. Provide it on the host's implementation.
 */
export const WriteStorageZoneHttp = Layer.effect(
  WriteStorageZone,
  Effect.suspend(() => makeStorageZoneHttp({ level: "Write", makeClient: makeWriteStorageZoneClient })),
).pipe(Layer.provide(storageZoneHttpLayer));

const encoder = new TextEncoder();

/** Build the write client over a bound zone. */
export const makeWriteStorageZoneClient = ({ run }: StorageZoneHttp): WriteStorageZoneClient => ({
  put: (key, body, options) =>
    run((access) =>
      Storage.putObject(access, zoneKey(key), typeof body === "string" ? encoder.encode(body) : body, {
        contentType: options?.contentType,
      }),
    ),
  delete: (key) => run((access) => Storage.deleteObject(access, zoneKey(key))),
});
