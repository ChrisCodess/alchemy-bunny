import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "./DatabaseD1.ts";

/**
 * Bind a {@link Database} and obtain the Effect-native query client
 * (`prepare`, `exec`, `batch`, `raw`) — the Bunny counterpart of
 * `Cloudflare.D1.QueryDatabase`, on a `Bunny.EdgeScript` or any other
 * Alchemy host with a runtime context.
 *
 * `QueryDatabase` is at once the binding's Context tag, its type and the
 * callable — `yield* Bunny.QueryDatabase(db)`. Provide
 * {@link QueryDatabaseHttp} on the host's implementation (it issues a
 * full-access `Bunny.DatabaseToken` and binds the URL and token), or
 * {@link QueryDatabaseLocal} in a deploy-time `Action`.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const db = yield* Bunny.QueryDatabase(Db);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const { results } = yield* db.prepare("SELECT * FROM users WHERE id = ?").bind(1).all();
 *       return yield* HttpServerResponse.json(results);
 *     }),
 *   };
 * }).pipe(Effect.provide(Bunny.QueryDatabaseHttp))
 * ```
 *
 * @binding
 */
export interface QueryDatabase extends Binding.Service<
  QueryDatabase,
  "Bunny.QueryDatabase",
  (database: Database) => Effect.Effect<QueryDatabaseClient>
> {}

export const QueryDatabase = Binding.Service<QueryDatabase>("Bunny.QueryDatabase");

/** A query failed: SQL error, auth, or transport (`cause` holds the client's error). */
export class DatabaseQueryError extends Data.TaggedError("DatabaseQueryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const toQueryError = (cause: unknown) =>
  new DatabaseQueryError({ message: cause instanceof Error ? cause.message : String(cause), cause });

const attempt = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: toQueryError });

/**
 * A prepared statement, like `Cloudflare.D1`'s: `prepare` and `bind` build
 * it without touching the database; the executors (`all`, `first`, `run`,
 * `raw`) run it.
 */
export class PreparedStatement {
  /** @internal */
  constructor(
    private readonly query: string,
    private readonly binds: ReadonlyArray<unknown>,
    private readonly rawEff: Effect.Effect<D1Database, never, RuntimeContext>,
  ) {}

  /** A new statement bound to `values` (replacing earlier bindings). */
  bind(...values: unknown[]): PreparedStatement {
    return new PreparedStatement(this.query, values, this.rawEff);
  }

  /** Run the query and return all rows. */
  all<T = Record<string, unknown>>(): Effect.Effect<D1Result<T>, DatabaseQueryError, RuntimeContext> {
    return this.withStatement((statement) => statement.all<T>());
  }

  /** Run the query and return the first row (or one of its columns), or `null`. */
  first<T = Record<string, unknown>>(column?: string): Effect.Effect<T | null, DatabaseQueryError, RuntimeContext> {
    return this.withStatement((statement) => statement.first<T>(column));
  }

  /** Run the query as a mutation; `meta` holds the changes and last row id. */
  run<T = Record<string, unknown>>(): Effect.Effect<D1Result<T>, DatabaseQueryError, RuntimeContext> {
    return this.withStatement((statement) => statement.run<T>());
  }

  /** Run the query and return rows as arrays (with the column names first when asked). */
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Effect.Effect<T[], DatabaseQueryError, RuntimeContext> {
    return this.withStatement((statement) => statement.raw<T>(options));
  }

  /** @internal Materialize against a connection (for `batch`). */
  _build(raw: D1Database): D1PreparedStatement {
    const statement = raw.prepare(this.query);
    return this.binds.length > 0 ? statement.bind(...this.binds) : statement;
  }

  private withStatement<A>(fn: (statement: D1PreparedStatement) => Promise<A>) {
    return Effect.flatMap(this.rawEff, (raw) => attempt(() => fn(this._build(raw))));
  }
}

export interface QueryDatabaseClient {
  /**
   * A D1-compatible connection (see `DatabaseD1.ts`), for libraries that
   * take a D1 binding (Better Auth, `drizzle-orm/d1`).
   */
  raw: Effect.Effect<D1Database, never, RuntimeContext>;
  /** Prepare a statement; nothing runs until an executor is yielded. */
  prepare: (query: string) => PreparedStatement;
  /** Run SQL without parameters (one or more statements). */
  exec: (query: string) => Effect.Effect<{ count: number; duration: number }, DatabaseQueryError, RuntimeContext>;
  /** Run statements in order in one transaction; a failure rolls all of them back. */
  batch: <T = Record<string, unknown>>(
    statements: PreparedStatement[],
  ) => Effect.Effect<D1Result<T>[], DatabaseQueryError, RuntimeContext>;
}

/** Build a {@link QueryDatabaseClient} over a (deferred) D1-compatible connection. */
export const makeQueryDatabaseClient = (
  rawEff: Effect.Effect<D1Database, never, RuntimeContext>,
): QueryDatabaseClient => ({
  raw: rawEff,
  prepare: (query) => new PreparedStatement(query, [], rawEff),
  exec: (query) => Effect.flatMap(rawEff, (raw) => attempt(() => raw.exec(query))),
  batch: <T = Record<string, unknown>>(statements: PreparedStatement[]) =>
    Effect.flatMap(rawEff, (raw) => attempt(() => raw.batch<T>(statements.map((statement) => statement._build(raw))))),
});
