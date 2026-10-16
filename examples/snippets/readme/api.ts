// README "Bindings in one example".
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";

export const Uploads = Bunny.StorageZone("Uploads", {});
export const Db = Bunny.Database("Db", { migrations: "./migrations" });

export default class Api extends Bunny.EdgeScript<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Bunny.ReadWriteStorageZone(yield* Uploads);
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        yield* uploads.put("hello.txt", "hello");
        const row = yield* db.prepare("SELECT count(*) AS n FROM notes").first<{ n: number }>();
        return yield* HttpServerResponse.json({ notes: row?.n });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Bunny.ReadWriteStorageZoneHttp, Bunny.QueryDatabaseHttp))),
) {}
