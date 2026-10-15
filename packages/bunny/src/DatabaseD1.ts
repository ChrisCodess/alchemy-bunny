/**
 * A Cloudflare-D1-compatible view of a Bunny Database.
 *
 * Libraries that accept a D1 binding — Better Auth (its built-in D1 Kysely
 * dialect), Drizzle's `drizzle-orm/d1` — can use a Bunny Database through
 * this adapter. It wraps `@bunny.net/database-client`, so it runs anywhere
 * `fetch` does (Edge Scripting, Bun, Node) and imports nothing from Alchemy
 * or Effect: safe to bundle into an Edge Script.
 *
 * Covered: `prepare().bind()` with `all`, `first`, `run`, `raw`; `batch`
 * (one transaction, like D1); `exec`. Like D1 over HTTP there are no
 * interactive transactions.
 *
 * @example
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { connectD1 } from "alchemy-bunny/DatabaseD1";
 *
 * // Reads BUNNY_DATABASE_URL and BUNNY_DATABASE_AUTH_TOKEN.
 * export const auth = betterAuth({ database: connectD1(), ... });
 * ```
 */
import {
  connect,
  type Config,
  type Database as BunnyDatabaseClient,
  type Result,
  type Statement,
} from "@bunny.net/database-client";

export interface D1Meta {
  changes: number;
  last_row_id: number | null;
  duration: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: D1Meta;
}

const toNumber = (value: number | bigint | null): number | null =>
  value === null ? null : Number(value);

const toD1Result = <T>(result: Result<T>, started: number): D1Result<T> => ({
  results: result.rows,
  success: true,
  meta: {
    changes: result.rowsAffected,
    last_row_id: toNumber(result.lastInsertRowid),
    duration: Date.now() - started,
    changed_db: result.rowsAffected > 0,
    size_after: 0,
    rows_read: 0,
    rows_written: result.rowsAffected,
  },
});

export class D1PreparedStatement {
  /** @internal */
  readonly statement: Statement;

  constructor(statement: Statement) {
    this.statement = statement;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.statement.bind(...values));
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const started = Date.now();
    return toD1Result(await this.statement.run<T>(), started);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.statement.run<Record<string, unknown>>()).rows[0];
    if (row === undefined) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = await this.statement.runRaw();
    const rows = result.rows as unknown as T[];
    return options?.columnNames ? [result.columns as unknown as T, ...rows] : rows;
  }
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

/** A D1-compatible view of a `@bunny.net/database-client` connection. */
export const toD1 = (db: BunnyDatabaseClient): D1Database => ({
  prepare: (sql) => new D1PreparedStatement(db.prepare(sql)),
  batch: async <T>(statements: D1PreparedStatement[]) => {
    if (statements.length === 0) return [];
    const started = Date.now();
    const results = await db.batch(statements.map((statement) => statement.statement));
    return results.map((result) => toD1Result(result as Result<T>, started));
  },
  exec: async (sql) => {
    const started = Date.now();
    await db.exec(sql);
    return { count: 1, duration: Date.now() - started };
  },
});

/**
 * Connect and return a D1-compatible database. `url` and `authToken`
 * default to `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN`.
 */
export const connectD1 = (config?: Partial<Config>): D1Database => toD1(connect(config));
