import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Database } from "./Database.ts";
import { connectD1 } from "./DatabaseD1.ts";
import { DatabaseToken } from "./DatabaseToken.ts";
import { makeQueryDatabaseClient, QueryDatabase } from "./QueryDatabase.ts";

/**
 * Logical ID of the token {@link QueryDatabaseHttp} issues for a database.
 * Derived from the database only, not the host (like Alchemy's Prisma
 * bucket keys): the deployed bundle re-runs the binding without a host and
 * must reach the same identity, and every host querying one database
 * shares the token.
 */
export const queryDatabaseTokenLogicalId = (database: Pick<Database, "LogicalId">) =>
  `${database.LogicalId}QueryDatabaseToken`;

const required = <A>(name: string, accessor: Effect.Effect<A | undefined>) =>
  Effect.flatMap(accessor, (value) =>
    value === undefined
      ? Effect.die(new Error(`Database binding is missing its ${name}; is QueryDatabaseHttp provided on this host?`))
      : Effect.succeed(value),
  );

/**
 * Implementation of {@link QueryDatabase} over the database's HTTP (Hrana)
 * endpoint. It issues a full-access `Bunny.DatabaseToken` for the database
 * and binds the database URL and the token (as a secret) into the host —
 * yielded Outputs, like Alchemy's Stripe and Prisma capabilities, so any
 * host with a runtime context carries them.
 *
 * The token (`<database>QueryDatabaseToken`) never expires and takes no
 * options; see `DatabaseToken` for what revoking a database's tokens means
 * for it.
 */
export const QueryDatabaseHttp = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    const Token = yield* DatabaseToken;
    return Effect.fn(function* (database: Database) {
      const token = yield* Token(queryDatabaseTokenLogicalId(database), { database });
      // Yielding an Output binds it into the host (plan) and returns its
      // runtime accessor.
      const url = yield* database.url;
      const authToken = yield* token.token;
      return makeQueryDatabaseClient(
        Effect.gen(function* () {
          // A connection is a plain object (no I/O until a query), so one
          // per use keeps nothing across requests.
          return connectD1({
            url: yield* required("url", url),
            authToken: Redacted.value(yield* required("token", authToken)),
            timeout: 10_000,
          });
        }),
      );
    });
  }),
);
