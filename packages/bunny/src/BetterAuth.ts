/**
 * `alchemy-bunny/BetterAuth` — the Bunny Database layer for
 * `@alchemy.run/better-auth`, the counterpart of its `CloudflareD1` layer
 * and built the same way: the runtime database is the
 * `Bunny.QueryDatabase` binding's D1-compatible `raw` connection, and the
 * deploy-time schema migration connects through `QueryDatabaseLocal`.
 *
 * Use it the stock way: call `BetterAuth({...})` inside an Effect-native host
 * (`Bunny.EdgeScript`) and provide this layer.
 *
 * ```typescript
 * export const AuthDb = Bunny.Database("AuthDb", {});
 *
 * export default class AuthApi extends Bunny.EdgeScript<AuthApi>()(
 *   "AuthApi",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const auth = yield* BetterAuth({ basePath: "/api/auth", emailAndPassword: { enabled: true } });
 *     return { fetch: auth.fetch };
 *   }).pipe(Effect.provide(BunnyDatabase(AuthDb))),
 * ) {}
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer @alchemy.run/better-auth
 */
import {
  Database as AuthDatabase,
  type BetterAuthMigrationError,
  type DatabaseService,
  type DirectDatabase,
} from "@alchemy.run/better-auth";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Database } from "./Database.ts";
import { QueryDatabase } from "./QueryDatabase.ts";
import { QueryDatabaseHttp } from "./QueryDatabaseHttp.ts";
import { QueryDatabaseLocal } from "./QueryDatabaseLocal.ts";

/**
 * `Database` layer for `@alchemy.run/better-auth` backed by a Bunny Database.
 *
 * At runtime Better Auth reaches the database through the
 * `Bunny.QueryDatabase` binding (the layer bakes in `QueryDatabaseHttp`: a
 * full-access token and the URL bound into the host), using its D1 dialect —
 * no interactive transactions, like D1. Schema migrations run at deploy
 * time through `QueryDatabaseLocal` (the current credentials).
 */
export const BunnyDatabase = (database: Database | Effect.Effect<Database, never, any>) =>
  Layer.effect(
    AuthDatabase,
    Effect.gen(function* () {
      const db = Effect.isEffect(database) ? yield* (database as Effect.Effect<Database>) : database;
      const client = yield* QueryDatabase(db);
      const service: DatabaseService = {
        provider: "sqlite",
        runtime: client.raw as unknown as DatabaseService["runtime"],
      };
      // Migration support references the deploy-time client
      // (`QueryDatabaseLocal`), which must never reach an Edge Script
      // bundle — this branch is dead-code-eliminated from deployed runtimes.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        return {
          ...service,
          migrate: {
            identity: { databaseId: db.databaseId } as Record<string, unknown>,
            connect: Effect.gen(function* () {
              // Init half — runs under the migration Action's capture
              // context: `QueryDatabase(db)` yields the database's id and URL
              // Outputs, recording the dependency; `raw` resolves at apply.
              const local = yield* QueryDatabase(db);
              // Apply half — the D1-compatible connection.
              return Effect.map(local.raw, (connection) => connection as unknown as DirectDatabase);
            }).pipe(
              Effect.provide(QueryDatabaseLocal),
              (effect) =>
                // QueryDatabaseLocal's build requirements (bunny.net
                // credentials, HttpClient) are ambient during stack
                // evaluation, where the init half runs.
                effect as unknown as Effect.Effect<
                  Effect.Effect<DirectDatabase, BetterAuthMigrationError, Scope.Scope>,
                  never,
                  RuntimeContext
                >,
            ),
          },
        } satisfies DatabaseService;
      }
      return service;
    }),
  ).pipe(Layer.provide(QueryDatabaseHttp)) as Layer.Layer<AuthDatabase>;
