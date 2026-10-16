// docs/database.md: a database with migrations, queried from an Effect-native
// Edge Script (QueryDatabaseHttp) and seeded by a deploy-time Action
// (QueryDatabaseLocal).
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";

export const Db = Bunny.Database("Db", {
  migrations: "./migrations", // *.sql, applied in order on every deploy
  replicaRegions: ["UK"],
});

export default class Notes extends Bunny.EdgeScript<Notes>()(
  "Notes",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        const { results } = yield* db
          .prepare("SELECT id, body FROM notes ORDER BY id DESC LIMIT ?")
          .bind(20)
          .all<{ id: number; body: string }>();
        return yield* HttpServerResponse.json(results);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.QueryDatabaseHttp)),
) {}

export const Seed = Alchemy.Action(
  "Seed",
  Effect.gen(function* () {
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return Effect.fn(function* () {
      yield* db.prepare("INSERT INTO notes (body) VALUES (?)").bind("hello").run();
    });
  }).pipe(Effect.provide(Bunny.QueryDatabaseLocal)),
);
