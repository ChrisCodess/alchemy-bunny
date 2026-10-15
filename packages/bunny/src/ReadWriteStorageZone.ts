import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadStorageZoneClient } from "./ReadStorageZone.ts";
import type { StorageZone } from "./StorageZone.ts";
import type { WriteStorageZoneClient } from "./WriteStorageZone.ts";

/**
 * Bind a {@link StorageZone} with read and write access and obtain the typed
 * runtime client — on a `Bunny.EdgeScript` or any other Alchemy host with a
 * runtime context. The host gets the zone's full
 * password (as a secret). Provide {@link ReadWriteStorageZoneHttp} on the
 * host's implementation.
 *
 * ```typescript
 * const files = yield* Bunny.ReadWriteStorageZone(zone);
 * yield* files.put("hello.txt", "hello");
 * const file = yield* files.get("hello.txt");
 * ```
 *
 * @binding
 */
export interface ReadWriteStorageZone extends Binding.Service<
  ReadWriteStorageZone,
  "Bunny.ReadWriteStorageZone",
  (zone: StorageZone) => Effect.Effect<ReadWriteStorageZoneClient>
> {}

export const ReadWriteStorageZone = Binding.Service<ReadWriteStorageZone>("Bunny.ReadWriteStorageZone");

export interface ReadWriteStorageZoneClient extends ReadStorageZoneClient, WriteStorageZoneClient {}
