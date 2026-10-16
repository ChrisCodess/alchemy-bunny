/**
 * Bunny Database SQL client — hand-written.
 *
 * Talks Hrana over HTTP (`POST {url}/v2/pipeline`), the protocol the official
 * `@bunny.net/database-client` uses. Behaviour confirmed against the live
 * service (probed 2026-09-29):
 *
 *   - URL: the database's `libsql://…` URL with `https:`; auth
 *     `Authorization: Bearer <database token>` (not the account key)
 *   - `execute` runs exactly one statement (two → `SQL_MANY_STATEMENTS`);
 *     `sequence` runs a script and stops at the first failing statement
 *   - `BEGIN; …; COMMIT;` in one `sequence`, followed by `ROLLBACK`, is
 *     all-or-nothing: after a failure the ROLLBACK undoes the partial work,
 *     after a commit it fails with "no transaction is active" (ignored)
 *   - 421 "struggling to contact your database" right after creation or a
 *     region change is transient; retried, as are 429 and 5xx
 *   - a lost request or response is retried for a single statement, never
 *     for a transaction: the server may have committed it
 *   - any other status (a 400, a 404) is a client error and is not retried
 *   - statement errors come back as HTTP 200 with a `{ type: "error" }` result
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/** Where and how to reach one database. */
export interface DatabaseConnection {
  /** The database URL (`libsql://…`, `https://…` or `http://…`). */
  readonly url: string;
  /** A database token (`generateDatabaseToken`). */
  readonly authToken: Redacted.Redacted<string>;
}

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/** The token is missing, invalid, revoked, expired, or lacks write access. */
export class SqlUnauthorized extends Data.TaggedError("SqlUnauthorized")<{
  readonly status: number;
  readonly message: string;
}> {}

/** The database is not reachable yet (421), or the service failed (5xx). */
export class SqlUnavailable extends Data.TaggedError("SqlUnavailable")<{
  readonly status: number;
  readonly message: string;
}> {}

/** A statement failed (SQLite error, syntax error, constraint, …). */
export class SqlStatementError extends Data.TaggedError("SqlStatementError")<{
  readonly code: string | undefined;
  readonly message: string;
}> {}

/** The request could not be sent or the response could not be read. */
export class SqlTransportError extends Data.TaggedError("SqlTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A status the service is not expected to answer (a 400, a 404, …), or an unreadable body. */
export class SqlHttpError extends Data.TaggedError("SqlHttpError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SqlError =
  | SqlUnauthorized
  | SqlUnavailable
  | SqlStatementError
  | SqlTransportError
  | SqlHttpError;

type WireValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

interface WireResult {
  type: "ok" | "error";
  response?: {
    type: string;
    result?: { cols: { name: string | null }[]; rows: WireValue[][] };
  };
  error?: { message: string; code?: string };
}

export const pipelineUrl = (url: string): string =>
  `${url.replace(/^libsql:/, "https:").replace(/\/+$/, "")}/v2/pipeline`;

const encodeValue = (value: unknown): WireValue => {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { type: "integer", value: value.toString() }
      : { type: "float", value };
  }
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  return { type: "text", value: String(value) };
};

const decodeValue = (value: WireValue): SqlValue => {
  switch (value.type) {
    case "null":
      return null;
    case "integer": {
      const big = BigInt(value.value);
      return big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)
        ? big
        : Number(big);
    }
    case "float":
      return value.value;
    case "text":
      return value.value;
    case "blob":
      // Returned without padding; Buffer accepts that.
      return new Uint8Array(Buffer.from(value.base64, "base64"));
  }
};

/** The server did not process the request (421, 429, 5xx). */
const notProcessed = (error: SqlError) => error._tag === "SqlUnavailable";

/** The server did not process it, or the outcome is unknown (lost request or response). */
const notProcessedOrLost = (error: SqlError) => notProcessed(error) || error._tag === "SqlTransportError";

/** Only 421 and 429: the request was refused before it ran. */
const refused = (error: SqlError) =>
  error._tag === "SqlUnavailable" && (error.status === 421 || error.status === 429);

/** Send one pipeline (plus `close`) and return the per-request results. */
const pipeline = (
  connection: DatabaseConnection,
  requests: ReadonlyArray<unknown>,
  retryWhile: (error: SqlError) => boolean,
): Effect.Effect<WireResult[], SqlError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(pipelineUrl(connection.url)).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(connection.authToken)}`),
      HttpClientRequest.bodyJsonUnsafe({ requests: [...requests, { type: "close" }] }),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new SqlTransportError({ message: String(cause), cause })));
    const text = yield* response.text.pipe(
      Effect.mapError((cause) => new SqlTransportError({ message: String(cause), cause })),
    );
    const status = response.status;
    if (status === 401 || status === 403) {
      return yield* new SqlUnauthorized({ status, message: errorText(text, status) });
    }
    if (status === 421 || status === 429 || status >= 500) {
      return yield* new SqlUnavailable({ status, message: errorText(text, status) });
    }
    if (status < 200 || status >= 300) {
      return yield* new SqlHttpError({ status, message: errorText(text, status) });
    }
    const body = yield* Effect.try({
      try: () => JSON.parse(text) as { results?: WireResult[] },
      catch: (cause) =>
        new SqlHttpError({ status, message: `unreadable response: ${text.slice(0, 200)}`, cause }),
    });
    return body.results ?? [];
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
      times: 8,
      while: retryWhile,
    }),
  );

const errorText = (text: string, status: number) => {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (typeof json.error === "string") return json.error;
  } catch {}
  return text.trim() || `HTTP ${status}`;
};

const failed = (result: WireResult | undefined) =>
  new SqlStatementError({
    code: result?.error?.code,
    message: result?.error?.message ?? "no result",
  });

/** Run one statement and return its rows as objects. */
export const query = (
  connection: DatabaseConnection,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Effect.Effect<SqlRow[], SqlError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const [result] = yield* pipeline(
      connection,
      [{ type: "execute", stmt: { sql, args: params.map(encodeValue), want_rows: true } }],
      notProcessedOrLost,
    );
    if (result?.type !== "ok" || !result.response?.result) return yield* failed(result);
    const { cols, rows } = result.response.result;
    return rows.map((row) =>
      Object.fromEntries(cols.map((col, index) => [col.name ?? String(index), decodeValue(row[index]!)])),
    );
  });

/**
 * Run SQL scripts (each may hold several statements) in one transaction:
 * all of them apply, or none do. Retried only when the server refused the
 * request (421, 429): after a lost response, or a 5xx from a gateway, the
 * transaction may have been committed, and sending it again would apply
 * it twice.
 */
export const transaction = (
  connection: DatabaseConnection,
  scripts: ReadonlyArray<string>,
): Effect.Effect<void, SqlError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = scripts
      .map((script) => script.trim())
      .filter((script) => script.length > 0)
      // A new line before `;` keeps a trailing `-- comment` from swallowing it.
      .map((script) => (script.endsWith(";") ? script : `${script}\n;`))
      .join("\n");
    if (body.length === 0) return;
    const [result] = yield* pipeline(
      connection,
      [
        { type: "sequence", sql: `BEGIN;\n${body}\nCOMMIT;` },
        // Undoes a failed sequence; after a commit it fails harmlessly.
        { type: "execute", stmt: { sql: "ROLLBACK" } },
      ],
      refused,
    );
    if (result?.type !== "ok") return yield* failed(result);
  });
