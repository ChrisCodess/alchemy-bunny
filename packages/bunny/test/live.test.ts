/**
 * Live test against a real bunny.net account. It creates a storage zone and
 * a pull zone, serves a page through the CDN, updates it, and destroys
 * everything (also when an assertion fails).
 *
 * Skipped unless BUNNY_LIVE=1 and BUNNY_API_KEY is set. Run it on its own:
 *
 *   BUNNY_LIVE=1 BUNNY_API_KEY=... bun test test/live.test.ts
 *
 * Costs: a few KB of storage and CDN traffic for a few minutes, and Bunny
 * Databases that exist for a few minutes.
 */
import { expect } from "bun:test";
import { Sql } from "alchemy-bunny-sdk";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FETCH_KEY_HEADER, FORWARDED_URL_HEADER } from "../src/EdgeScriptFetch.ts";
import * as Bunny from "../src/index.ts";
import Callee from "./fixtures/callee.ts";
import Caller from "./fixtures/caller.ts";
import CapabilityApi from "./fixtures/capabilities.ts";
import { ACCOUNT_KEY } from "./mock-bunny.ts";

const live =
  process.env.BUNNY_LIVE === "1" &&
  !!process.env.BUNNY_API_KEY &&
  process.env.BUNNY_API_KEY !== ACCOUNT_KEY &&
  process.env.BUNNY_STORAGE_ENDPOINT === undefined;

const { test } = Test.make({ providers: Bunny.providers() });

/** GET `url` until the body contains `marker` (CDN and zone setup take a while). */
const waitForBody = (url: string, marker: string, headers: Record<string, string> = {}) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { headers: { "cache-control": "no-cache", ...headers } });
    const body = await response.text();
    if (!response.ok || !body.includes(marker)) {
      throw new Error(`${url}: ${response.status}, marker "${marker}" not found`);
    }
    return body;
  }).pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("5 seconds") }));

test.provider.skipIf(!live)(
  "live: a static site deploys, serves, updates, and is destroyed",
  (stack) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "bunny-live-"));
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "index.html"), "<h1>alchemy-live-v1</h1>");
      writeFileSync(join(dir, "assets/app.css"), "body{}");

      const program = Effect.gen(function* () {
        const site = yield* Bunny.Website.StaticSite("Site", { outdir: dir, spa: true });
        return {
          url: site.url,
          version: site.files!.version,
          storageZoneId: site.storageZone!.storageZoneId,
        };
      });

      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(program);
        yield* waitForBody(`${first.url}/`, "alchemy-live-v1");
        // SPA fallback: an unknown route serves index.html.
        yield* waitForBody(`${first.url}/some/client/route`, "alchemy-live-v1");

        // Nothing changed: same version, same zone.
        const second = yield* stack.deploy(program);
        expect(second.version).toBe(first.version);
        expect(second.storageZoneId).toBe(first.storageZoneId);

        // One file changed: the CDN serves it after the purge.
        writeFileSync(join(dir, "index.html"), "<h1>alchemy-live-v2</h1>");
        const third = yield* stack.deploy(program);
        expect(third.version).not.toBe(first.version);
        yield* waitForBody(`${third.url}/`, "alchemy-live-v2");
      }).pipe(
        Effect.ensuring(
          stack.destroy().pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
          ),
        ),
      );
    }),
  { timeout: 600_000 },
);

test.provider.skipIf(!live)(
  "live: an edge script deploys, reads its variable, and is destroyed",
  (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const script = yield* stack.deploy(
          Bunny.EdgeScript("Hello", {
            main: join(import.meta.dir, "fixtures/edge-hello.ts"),
            env: { GREETING: "alchemy-live-edge" },
          }),
        );
        expect(script.url).toMatch(/^https:\/\/.+\.bunny\.run$/);
        yield* waitForBody(`${script.url}/ping`, "alchemy-live-edge");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }),
  { timeout: 600_000 },
);

test.provider.skipIf(!live)(
  "live: a database gets migrations and tokens, takes a new migration, and is destroyed",
  (stack) =>
    Effect.gen(function* () {
      const migrations = mkdtempSync(join(tmpdir(), "bunny-live-db-"));
      writeFileSync(join(migrations, "0001_notes.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);");
      writeFileSync(
        join(migrations, "0002_seed.sql"),
        "INSERT INTO notes (body) VALUES ('first');\nINSERT INTO notes (body) VALUES ('second');",
      );
      const program = Effect.gen(function* () {
        const db = yield* Bunny.Database("Db", { migrations });
        const full = yield* Bunny.DatabaseToken("Full", { database: db });
        const readOnly = yield* Bunny.DatabaseToken("ReadOnly", { database: db, authorization: "read-only" });
        return { databaseId: db.databaseId, url: db.url, full: full.token, readOnly: readOnly.token };
      });
      let databaseId: string | undefined;

      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(program);
        databaseId = first.databaseId;
        expect(first.url).toMatch(/^libsql:\/\/.+\.lite\.bunnydb\.net\/?$/);
        const writer = { url: first.url, authToken: first.full };
        const reader = { url: first.url, authToken: first.readOnly };

        const rows = yield* Sql.query(reader, "SELECT body FROM notes ORDER BY id");
        expect(rows.map((row) => row.body)).toEqual(["first", "second"]);
        yield* Sql.query(writer, "INSERT INTO notes (body) VALUES (?)", ["third"]);
        const denied = yield* Sql.query(reader, "INSERT INTO notes (body) VALUES ('nope')").pipe(Effect.flip);
        expect(denied._tag).toBe("SqlUnauthorized");

        // Nothing changed: same database, same tokens.
        const second = yield* stack.deploy(program);
        expect(second.databaseId).toBe(first.databaseId);

        // A new migration is applied on the next deploy.
        writeFileSync(join(migrations, "0003_tags.sql"), "ALTER TABLE notes ADD COLUMN tag TEXT;");
        yield* stack.deploy(program);
        const columns = yield* Sql.query(reader, "SELECT name FROM pragma_table_info('notes') ORDER BY cid");
        expect(columns.map((row) => row.name)).toEqual(["id", "body", "tag"]);
        const count = yield* Sql.query(reader, "SELECT count(*) AS n FROM __alchemy_migrations");
        expect(count[0]!.n).toBe(3);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.ensuring(
          stack.destroy().pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => rmSync(migrations, { recursive: true, force: true }))),
          ),
        ),
      );

      // Destroyed: the API no longer knows the database.
      const status = yield* Effect.promise(() =>
        fetch(`https://api.bunny.net/database/v2/databases/${databaseId}`, {
          headers: { AccessKey: process.env.BUNNY_API_KEY! },
        }).then((response) => response.status),
      );
      expect(status).toBe(404);
    }),
  { timeout: 600_000 },
);

test.provider.skipIf(!live)(
  "live: storage zone and database capabilities work inside an Effect-native edge script",
  (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const api = yield* CapabilityApi;
            return { url: api.url! };
          }),
        );
        // The script writes with the zone password, reads back with the
        // read-only one, and queries the database with the bound token.
        yield* waitForBody(`${out.url}/`, '{"file":"hello.txt","one":1}');
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }),
  { timeout: 600_000 },
);

test.provider.skipIf(!live)(
  "live: FetchEdgeScript — the callee handles a keyed request as the caller's URL and ignores unkeyed ones",
  (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const callee = yield* Callee;
            const caller = yield* Caller;
            return { callee: callee.url!, caller: caller.url! };
          }),
        );
        // Through the binding: the callee sees the URL the caller addressed.
        yield* waitForBody(`${out.caller}/`, '"url":"https://example.com/hello?x=1"');
        // Directly, with a forwarded URL but no key or a wrong key: the
        // callee handles its own URL.
        yield* waitForBody(`${out.callee}/direct`, `"url":"${out.callee}/direct"`, {
          [FORWARDED_URL_HEADER]: "https://evil.example/admin",
        });
        yield* waitForBody(`${out.callee}/direct`, `"url":"${out.callee}/direct"`, {
          [FORWARDED_URL_HEADER]: "https://evil.example/admin",
          [FETCH_KEY_HEADER]: "0".repeat(64),
        });
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }),
  { timeout: 600_000 },
);
