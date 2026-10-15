import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageZone } from "./StorageZone.ts";
import type { PutOptions, StorageError } from "./StorageZoneTypes.ts";

/**
 * Bind a {@link StorageZone} with write access and obtain the typed runtime
 * client — on a `Bunny.EdgeScript` or any other Alchemy host with a
 * runtime context.
 *
 * bunny.net has no write-only credential: the host gets the zone's full
 * password (as a secret), and the client exposes no reads. Provide
 * {@link WriteStorageZoneHttp} on the host's implementation.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const uploads = yield* Bunny.WriteStorageZone(zone);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const request = yield* HttpServerRequest.HttpServerRequest;
 *       const body = new Uint8Array(yield* request.arrayBuffer);
 *       yield* uploads.put(`uploads/${crypto.randomUUID()}.png`, body);
 *       return HttpServerResponse.empty({ status: 201 });
 *     }),
 *   };
 * }).pipe(Effect.provide(Bunny.WriteStorageZoneHttp))
 * ```
 *
 * @binding
 */
export interface WriteStorageZone extends Binding.Service<
  WriteStorageZone,
  "Bunny.WriteStorageZone",
  (zone: StorageZone) => Effect.Effect<WriteStorageZoneClient>
> {}

export const WriteStorageZone = Binding.Service<WriteStorageZone>("Bunny.WriteStorageZone");

export interface WriteStorageZoneClient {
  /** Upload a file, creating parent directories as needed. */
  put(
    key: string,
    body: Uint8Array | string,
    options?: PutOptions,
  ): Effect.Effect<void, StorageError, RuntimeContext>;
  /**
   * Delete a file, or with a key ending in `/` a directory and everything in
   * it. Deleting something missing succeeds.
   */
  delete(key: string): Effect.Effect<void, StorageError, RuntimeContext>;
}
