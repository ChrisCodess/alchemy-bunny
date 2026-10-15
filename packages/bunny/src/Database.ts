import { Database as DatabaseApi, Sql } from "alchemy-bunny-sdk";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import {
  diffMigrations,
  MigrationError,
  migrationsAttrs,
  migrationsInputOf,
  runMigrations,
  stampedOf,
  type MigrationsInput,
  type SqlExecutor,
} from "alchemy/SQL/Migrations/index";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { toRedacted } from "./internal.ts";
import type { Providers } from "./Providers.ts";

/** Regions a database can run in (primary) or replicate to. */
export type DatabaseRegion = DatabaseApi.PossibleRegion;

/** Where the data is stored at rest (`GET /database/v1/config`). */
export type DatabaseStorageRegion = "eu-west-1" | "us-east-1" | (string & {});

export interface DatabaseProps {
  /**
   * Database name: lowercase letters, digits and single hyphens, at most 16
   * characters. bunny.net cannot rename a database, so changing it replaces
   * the database (and loses its data).
   *
   * If omitted, a name is generated from the logical ID and a unique suffix.
   * Names are not unique on bunny.net; the database is tracked by its id.
   */
  name?: string;
  /**
   * Regions the database runs in. Changed in place.
   * @default ["DE"]
   */
  primaryRegions?: DatabaseRegion[];
  /**
   * Regions that hold read replicas. Changed in place.
   * @default []
   */
  replicaRegions?: DatabaseRegion[];
  /**
   * Where the data is stored at rest. Chosen when the database is created
   * (the default is the storage region in the first primary region's group,
   * as the official CLI does); changing it replaces the database.
   */
  storageRegion?: DatabaseStorageRegion;
  /**
   * SQL migrations to apply on every deploy: a directory of `.sql` files, a
   * `{ dir, table? }` object, or a `Drizzle.Schema`. Applied migrations are
   * recorded in `__alchemy_migrations` and skipped afterwards; each
   * migration runs in one transaction.
   */
  migrations?: MigrationsInput;
}

export interface DatabaseAttributes {
  /** `db_<ulid>`. Stable across updates. */
  databaseId: string;
  name: string;
  /** `libsql://<id>-<name>.lite.bunnydb.net/` — the `BUNNY_DATABASE_URL`. */
  url: string;
  storageRegion: string;
  primaryRegions: string[];
  replicaRegions: string[];
  migrationsDir: string | undefined;
  migrationsTable: string | undefined;
  migrationsHashes: Record<string, string>;
}

export type Database = Resource<
  "Bunny.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

/**
 * A Bunny Database: SQLite-compatible (libSQL), with primary regions and
 * read replicas. Connect with `@bunny.net/database-client` using the
 * database `url` and a `DatabaseToken`.
 * @see https://docs.bunny.net/database
 *
 * @example
 * ```typescript
 * const db = yield* Bunny.Database("Db", {
 *   primaryRegions: ["DE"],
 *   migrations: "./migrations",
 * });
 * const token = yield* Bunny.DatabaseToken("DbToken", { database: db });
 * const api = yield* Bunny.EdgeScript("Api", {
 *   main: "./src/api.ts",
 *   variables: { BUNNY_DATABASE_URL: db.url },
 *   secrets: { BUNNY_DATABASE_AUTH_TOKEN: token.token },
 * });
 * ```
 *
 * @resource
 */
export const Database = Resource<Database>("Bunny.Database");

/**
 * An explicit `name` matches more than one database in the account
 * (bunny.net allows duplicate names), so Alchemy cannot tell which one to
 * manage.
 */
export class DatabaseNameAmbiguous extends Data.TaggedError("DatabaseNameAmbiguous")<{
  readonly name: string;
  readonly databaseIds: readonly string[];
  readonly message: string;
}> {}

const DEFAULT_PRIMARY_REGIONS: DatabaseRegion[] = ["DE"];
const NAME_MAX_LENGTH = 16;
/** Lifetime of the token Alchemy creates to apply migrations. */
const MIGRATION_TOKEN_TTL_MS = 15 * 60_000;

/**
 * `<id slug>-<8 chars>`, within the 16-character limit: at most 7
 * characters of the logical ID, then 40 bits of the instance id.
 */
const generatedName = (id: string) => {
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, NAME_MAX_LENGTH - 9)
      .replace(/-+$/, "") || "db";
  return createPhysicalName({
    id,
    prefix: `${slug}-`,
    suffixLength: 8,
    maxLength: NAME_MAX_LENGTH,
    lowercase: true,
  });
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

const desiredOf = (news: DatabaseProps) => ({
  primaryRegions: [...(news.primaryRegions ?? DEFAULT_PRIMARY_REGIONS)],
  replicaRegions: [...(news.replicaRegions ?? [])],
});

type Observed = Omit<DatabaseAttributes, "migrationsDir" | "migrationsTable" | "migrationsHashes">;

const toObserved = (db: DatabaseApi.Database2): Observed => ({
  databaseId: db.id,
  name: db.name,
  url: db.url,
  storageRegion: db.storage_region,
  primaryRegions: [...db.primary_regions],
  replicaRegions: [...db.replicas_regions],
});

const getDb = (databaseId: string) =>
  DatabaseApi.getDatabase({ db_id: databaseId }).pipe(
    Effect.map((response) => response.db),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/** Every database with exactly this name (`search` narrows, the match is exact). */
const findByName = (name: string) =>
  Effect.gen(function* () {
    const matches: DatabaseApi.Database2[] = [];
    for (let page = 1; ; page++) {
      const response = yield* DatabaseApi.listDatabases({ page, per_page: 100, search: name });
      matches.push(...response.databases.filter((db) => db.name === name));
      if (!response.page_info.has_more_items || response.databases.length === 0) break;
    }
    return matches;
  });

const findOneByName = (name: string) =>
  Effect.gen(function* () {
    const matches = yield* findByName(name);
    if (matches.length > 1) {
      return yield* new DatabaseNameAmbiguous({
        name,
        databaseIds: matches.map((db) => db.id),
        message:
          `${matches.length} databases are named "${name}" (${matches.map((db) => db.id).join(", ")}). ` +
          `bunny.net allows duplicate names, so Alchemy cannot tell which one to manage. ` +
          `Delete or rename the extra databases, or use a different name.`,
      });
    }
    return matches[0];
  });

/** The storage region in the first primary region's group (the official CLI's rule). */
const defaultStorageRegion = (primaryRegions: readonly string[]) =>
  Effect.gen(function* () {
    const config = yield* DatabaseApi.getDatabaseConfig({});
    const group = config.primary_regions.find((region) => region.id === primaryRegions[0])?.group;
    const storage =
      config.storage_region_available.find((region) => region.group === group) ??
      config.storage_region_available[0];
    return storage?.id ?? "eu-west-1";
  });

const toMigrationError = (what: string) => (cause: Sql.SqlError) =>
  new MigrationError({ message: `Bunny Database ${what} failed: ${cause.message}`, cause });

/**
 * Run `apply` with a migration executor for the database: a short-lived
 * full-access token (never persisted) over the Hrana pipeline.
 */
export const withDatabaseExecutor = <A, E, R>(
  database: { readonly databaseId: string; readonly url: string },
  apply: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { token } = yield* DatabaseApi.generateDatabaseToken({
      db_id: database.databaseId,
      authorization: "full-access",
      expires_at: new Date(Date.now() + MIGRATION_TOKEN_TTL_MS).toISOString(),
    });
    const connection: Sql.DatabaseConnection = { url: database.url, authToken: toRedacted(token) };
    // The executor contract has no requirements: capture the HttpClient here.
    const client = yield* HttpClient.HttpClient;
    const withClient = <X, Y>(effect: Effect.Effect<X, Y, HttpClient.HttpClient>) =>
      Effect.provideService(effect, HttpClient.HttpClient, client);
    const executor: SqlExecutor = {
      dialect: "sqlite",
      query: (sql, params) =>
        Sql.query(connection, sql, params).pipe(
          Effect.map((rows) => rows as Array<Record<string, unknown>>),
          Effect.mapError(toMigrationError("query")),
          withClient,
        ),
      batch: (statements) =>
        Sql.transaction(connection, statements).pipe(
          Effect.mapError(toMigrationError("migration")),
          withClient,
        ),
    };
    return yield* apply(executor);
  });

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "name", "url", "storageRegion"],
    // Non-listable: bunny.net has no tags, so managed databases cannot be
    // told apart from others in the account.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.name !== undefined && news.name !== output.name) return { action: "replace" } as const;
      if (news.storageRegion !== undefined && news.storageRegion !== output.storageRegion) {
        return { action: "replace" } as const;
      }
      const desired = desiredOf(news);
      if (
        !sameSet(desired.primaryRegions, output.primaryRegions) ||
        !sameSet(desired.replicaRegions, output.replicaRegions)
      ) {
        return { action: "update" } as const;
      }
      if (yield* diffMigrations({ news, output })) return { action: "update" } as const;
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.databaseId !== undefined) {
        const db = yield* getDb(output.databaseId);
        return db === undefined ? undefined : { ...output, ...toObserved(db) };
      }
      const explicitName = olds?.name;
      const db = yield* findOneByName(explicitName ?? (yield* generatedName(id)));
      if (db === undefined) return undefined;
      const attrs: DatabaseAttributes = {
        ...toObserved(db),
        ...migrationsAttrs({ input: olds && migrationsInputOf(olds), run: undefined, output: undefined }),
      };
      // A generated name embeds this resource's instance id; an explicit
      // name proves nothing about ownership.
      return explicitName === undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const desired = desiredOf(news);

      // 1. Observe — by id, else by generated name (recovers a create whose
      // state was lost; the name embeds this instance's id). An explicit
      // name is never looked up, including one kept from `output` after the
      // prop was removed: names are not unique, and during a replacement
      // the old database still carries it. Taking over an existing database
      // goes through `read` and `--adopt`.
      let db = output?.databaseId !== undefined ? yield* getDb(output.databaseId) : undefined;
      if (db === undefined && news.name === undefined && output?.name === undefined) {
        db = yield* findOneByName(name);
      }

      // 2. Ensure
      if (db === undefined) {
        const storageRegion =
          news.storageRegion ?? (yield* defaultStorageRegion(desired.primaryRegions));
        const created = yield* DatabaseApi.createDatabase({
          name,
          storage_region: storageRegion,
          primary_regions: desired.primaryRegions,
          replicas_regions: desired.replicaRegions,
        });
        db = yield* getDb(created.db_id);
        if (db === undefined) {
          return yield* Effect.die(new Error(`Bunny Database ${created.db_id} vanished right after creation`));
        }
        yield* session.note(`Created database ${name} (${db.id})`);
      }

      // 3. Sync regions (both lists in one PATCH).
      if (
        !sameSet(desired.primaryRegions, db.primary_regions) ||
        !sameSet(desired.replicaRegions, db.replicas_regions)
      ) {
        const updated = yield* DatabaseApi.updateDatabase({
          db_id: db.id,
          primary_regions: desired.primaryRegions,
          replicas_regions: desired.replicaRegions,
        });
        db = updated.db;
      }
      const observed = toObserved(db);

      // 4. Migrations (the shared pipeline is idempotent).
      const input = migrationsInputOf(news);
      const run = input
        ? yield* runMigrations({
            input,
            stamped: stampedOf(output),
            withExecutor: (apply) => withDatabaseExecutor(observed, apply),
          })
        : undefined;

      return { ...observed, ...migrationsAttrs({ input, run, output }) };
    }),
    delete: Effect.fn(function* ({ output }) {
      // DELETE answers 500 (not 404) for a database that no longer exists,
      // so decide "gone" with GET first.
      if ((yield* getDb(output.databaseId)) === undefined) return;
      yield* DatabaseApi.deleteDatabase({ db_id: output.databaseId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
