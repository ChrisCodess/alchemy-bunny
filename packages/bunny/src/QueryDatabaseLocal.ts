import { Credentials, Database as DatabaseApi } from "alchemy-bunny-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Database } from "./Database.ts";
import { connectD1, type D1Database } from "./DatabaseD1.ts";
import { toRedacted } from "./internal.ts";
import { makeQueryDatabaseClient, QueryDatabase } from "./QueryDatabase.ts";

/** Lifetime of the token `QueryDatabaseLocal` issues. */
const LOCAL_TOKEN_TTL_MS = 15 * 60_000;

/**
 * Deploy-time implementation of {@link QueryDatabase} — the counterpart of
 * `Cloudflare.D1.QueryDatabaseLocal`: it uses the **current** bunny.net
 * credentials instead of a bound token, so it binds nothing. On first use it
 * issues a short-lived full-access token (bunny.net's SQL endpoint only
 * takes database tokens) and reuses it.
 *
 * Provide it on an `Action` (or any deploy-time Effect):
 *
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const db = yield* Bunny.QueryDatabase(Db);
 *     return Effect.fn(function* () {
 *       yield* db.prepare("INSERT INTO users (name) VALUES (?)").bind("Ada").run();
 *     });
 *   }).pipe(Effect.provide(Bunny.QueryDatabaseLocal)),
 * );
 * ```
 *
 * The database id and URL resolve at apply time, so the database can be
 * created in the same deploy.
 */
export const QueryDatabaseLocal = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    // Credentials and HttpClient are ambient during stack evaluation (the
    // stack's providers layer); capture them for the apply-time token call.
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (database: Database) {
      const databaseId = yield* database.databaseId;
      const url = yield* database.url;
      let connection: D1Database | undefined;
      return makeQueryDatabaseClient(
        Effect.gen(function* () {
          if (connection !== undefined) return connection;
          const { token } = yield* DatabaseApi.generateDatabaseToken({
            db_id: yield* databaseId,
            authorization: "full-access",
            expires_at: new Date(Date.now() + LOCAL_TOKEN_TTL_MS).toISOString(),
          }).pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.orDie,
          );
          connection = connectD1({ url: yield* url, authToken: Redacted.value(toRedacted(token)) });
          return connection;
        }),
      );
    });
  }),
);
