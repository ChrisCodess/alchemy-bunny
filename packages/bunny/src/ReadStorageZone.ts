import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageZone } from "./StorageZone.ts";
import type { StorageError, StorageFile, StorageObject } from "./StorageZoneTypes.ts";

/**
 * Bind a {@link StorageZone} with read access and obtain the typed runtime
 * client — on a `Bunny.EdgeScript` or any other Alchemy host with a
 * runtime context.
 *
 * The host gets the zone's Edge Storage host, name and **read-only**
 * password (as a secret); bunny.net rejects writes made with that password.
 * Provide {@link ReadStorageZoneHttp} on the host's implementation.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const files = yield* Bunny.ReadStorageZone(zone);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const file = yield* files.get("reports/2026.json");
 *       return file === null
 *         ? HttpServerResponse.text("Not Found", { status: 404 })
 *         : HttpServerResponse.uint8Array(file.body, { contentType: file.contentType ?? undefined });
 *     }),
 *   };
 * }).pipe(Effect.provide(Bunny.ReadStorageZoneHttp))
 * ```
 *
 * @binding
 */
export interface ReadStorageZone extends Binding.Service<
  ReadStorageZone,
  "Bunny.ReadStorageZone",
  (zone: StorageZone) => Effect.Effect<ReadStorageZoneClient>
> {}

export const ReadStorageZone = Binding.Service<ReadStorageZone>("Bunny.ReadStorageZone");

export interface ReadStorageZoneClient {
  /** Download a file with its metadata; `null` when it does not exist. */
  get(key: string): Effect.Effect<StorageFile | null, StorageError, RuntimeContext>;
  /**
   * List one directory level (`""` for the root): files, and directories
   * (keys ending in `/`). A missing directory lists as empty.
   */
  list(directory?: string): Effect.Effect<readonly StorageObject[], StorageError, RuntimeContext>;
  /** List every file under `prefix`, recursively. */
  listFiles(prefix?: string): Effect.Effect<readonly StorageObject[], StorageError, RuntimeContext>;
}
