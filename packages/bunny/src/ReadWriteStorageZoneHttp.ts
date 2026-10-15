import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeReadStorageZoneClient } from "./ReadStorageZoneHttp.ts";
import { ReadWriteStorageZone, type ReadWriteStorageZoneClient } from "./ReadWriteStorageZone.ts";
import { makeStorageZoneHttp, storageZoneHttpLayer, type StorageZoneHttp } from "./StorageZoneHttp.ts";
import { makeWriteStorageZoneClient } from "./WriteStorageZoneHttp.ts";

/**
 * Implementation of {@link ReadWriteStorageZone} over the Edge Storage HTTP
 * API, with the zone's password. Provide it on the host's implementation.
 */
export const ReadWriteStorageZoneHttp = Layer.effect(
  ReadWriteStorageZone,
  Effect.suspend(() => makeStorageZoneHttp({ level: "ReadWrite", makeClient: makeReadWriteStorageZoneClient })),
).pipe(Layer.provide(storageZoneHttpLayer));

/** Build the read-write client from its read and write halves. */
export const makeReadWriteStorageZoneClient = (http: StorageZoneHttp): ReadWriteStorageZoneClient =>
  ({
    ...makeReadStorageZoneClient(http),
    ...makeWriteStorageZoneClient(http),
  }) satisfies ReadWriteStorageZoneClient;
