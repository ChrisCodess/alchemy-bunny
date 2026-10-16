import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Database } from "../../src/Database.ts";
import { EdgeScript } from "../../src/EdgeScript.ts";
import { QueryDatabase } from "../../src/QueryDatabase.ts";
import { QueryDatabaseHttp } from "../../src/QueryDatabaseHttp.ts";
import { ReadStorageZone } from "../../src/ReadStorageZone.ts";
import { ReadStorageZoneHttp } from "../../src/ReadStorageZoneHttp.ts";
import { ReadWriteStorageZone } from "../../src/ReadWriteStorageZone.ts";
import { ReadWriteStorageZoneHttp } from "../../src/ReadWriteStorageZoneHttp.ts";
import { StorageZone } from "../../src/StorageZone.ts";

export const Files = StorageZone("Files", {});
export const Db = Database("Db", {});

/** Storage (read and read-write) and database capabilities in one Edge Script. */
export default class CapabilityApi extends EdgeScript<CapabilityApi>()(
  "CapabilityApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const files = yield* Files;
    const reader = yield* ReadStorageZone(files);
    const writer = yield* ReadWriteStorageZone(files);
    const db = yield* QueryDatabase(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        yield* writer.put("hello.txt", "hello");
        const file = yield* reader.get("hello.txt");
        const row = yield* db.prepare("SELECT 1 AS one").first<{ one: number }>();
        return yield* HttpServerResponse.json({ file: file?.key, one: row?.one });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(ReadStorageZoneHttp, ReadWriteStorageZoneHttp, QueryDatabaseHttp))),
) {}
