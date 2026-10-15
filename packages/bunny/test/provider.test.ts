/**
 * Provider lifecycle tests: the real Alchemy engine (plan, apply, destroy)
 * against the in-memory bunny.net stand-in in `mock-bunny.ts`.
 *
 * They prove the provider logic (observe/ensure/sync, diffs, ordering,
 * idempotency). They do not prove bunny.net behaves like the mock; the live
 * tests in `live.test.ts` do that against a real account.
 */
import { afterAll, expect } from "bun:test";
import * as Namespace from "alchemy/Namespace";
import * as Test from "alchemy/Test/Bun";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackEnvValue } from "alchemy/RuntimeContext";
import AuthApi from "./fixtures/auth-api.ts";
import CapabilityApi, { Db as CapabilityDb, Files } from "./fixtures/capabilities.ts";
import Callee from "./fixtures/callee.ts";
import Caller from "./fixtures/caller.ts";
import * as Bunny from "../src/index.ts";
import { ACCOUNT_KEY, startMockBunny, type MockBunny } from "./mock-bunny.ts";

const mock: MockBunny = startMockBunny();
const ENV_KEYS = ["BUNNY_API_KEY", "BUNNY_API_BASE_URL", "BUNNY_STORAGE_ENDPOINT"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.BUNNY_API_KEY = ACCOUNT_KEY;
process.env.BUNNY_API_BASE_URL = mock.url;
process.env.BUNNY_STORAGE_ENDPOINT = mock.url;

const sites: string[] = [];
afterAll(() => {
  mock.stop();
  for (const dir of sites) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const { test } = Test.make({ providers: Bunny.providers() });

/** Create a site directory from `{ relativePath: contents }`. */
const makeSite = (tree: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "bunny-site-"));
  sites.push(dir);
  for (const [relative, contents] of Object.entries(tree)) {
    mkdirSync(join(dir, relative, ".."), { recursive: true });
    writeFileSync(join(dir, relative), contents);
  }
  return dir;
};

const writesSince = (index: number) =>
  mock.requests.slice(index).filter((request) => request.method !== "GET");

test.provider(
  "static site: create, no-op redeploy, one-file change, stale file purge, destroy",
  (stack) =>
    Effect.gen(function* () {
      const dir = makeSite({
        "index.html": "<h1>home</h1>",
        "about/index.html": "<h1>about</h1>",
        "assets/app.js": "console.log(1)",
      });
      const program = Effect.gen(function* () {
        const site = yield* Bunny.Website.StaticSite("Site", { outdir: dir, spa: true });
        return {
          url: site.url,
          storageZoneId: site.storageZone!.storageZoneId,
          pullZoneId: site.pullZone!.pullZoneId,
          fileCount: site.files!.fileCount,
          version: site.files!.version,
        };
      });

      // 1. Create
      const first = yield* stack.deploy(program);
      const zone = mock.storageZones.get(first.storageZoneId)!;
      const cdn = mock.pullZones.get(first.pullZoneId)!;
      expect(first.fileCount).toBe(3);
      expect(first.url).toBe(`https://${cdn.Name}.b-cdn.net`);
      expect(zone.Rewrite404To200).toBe(true);
      expect(zone.Custom404FilePath).toBe("/index.html");
      expect(cdn.OriginType).toBe(2);
      expect(cdn.StorageZoneId).toBe(zone.Id);
      expect(cdn.CacheControlMaxAgeOverride).toBe(2_592_000);
      expect(cdn.CacheControlPublicMaxAgeOverride).toBe(0);
      expect([...mock.files.get(zone.Name)!.keys()].sort()).toEqual([
        "about/index.html",
        "assets/app.js",
        "index.html",
      ]);
      expect(mock.files.get(zone.Name)!.get("index.html")!.contentType).toContain("text/html");
      // HTML is uploaded after the other assets.
      const uploadOrder = mock.uploads.slice(-3);
      expect(uploadOrder[0]).toBe("assets/app.js");
      expect(mock.purges).toEqual([cdn.Id]);

      // 2. Redeploy with nothing changed: no writes at all.
      const before = mock.requests.length;
      const second = yield* stack.deploy(program);
      expect(second.version).toBe(first.version);
      expect(writesSince(before)).toEqual([]);

      // 3. Change one file: exactly one upload and one purge.
      writeFileSync(join(dir, "about/index.html"), "<h1>about v2</h1>");
      const uploadsBefore = mock.uploads.length;
      const third = yield* stack.deploy(program);
      expect(third.version).not.toBe(first.version);
      expect(mock.uploads.slice(uploadsBefore)).toEqual(["about/index.html"]);
      expect(mock.purges).toEqual([cdn.Id, cdn.Id]);

      // 4. Remove a file: it is deleted from the zone.
      rmSync(join(dir, "assets/app.js"));
      yield* stack.deploy(program);
      expect(mock.files.get(zone.Name)!.has("assets/app.js")).toBe(false);
      expect(mock.purges.length).toBe(3);

      // 5. Destroy: pull zone and storage zone are gone.
      yield* stack.destroy();
      expect(mock.pullZones.has(cdn.Id)).toBe(false);
      expect(mock.storageZones.get(zone.Id)!.Deleted).toBe(true);
    }),
  { timeout: 60_000 },
);

test.provider(
  "changing the region replaces the storage zone without deleting the pull zone",
  (stack) =>
    Effect.gen(function* () {
      const dir = makeSite({ "index.html": "<h1>replace</h1>" });
      const deploy = (region: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* Bunny.Website.StaticSite("Site", { outdir: dir, region });
            return {
              storageZoneId: site.storageZone!.storageZoneId,
              pullZoneId: site.pullZone!.pullZoneId,
            };
          }),
        );

      const before = yield* deploy("DE");
      const after = yield* deploy("NY");
      expect(after.storageZoneId).not.toBe(before.storageZoneId);
      // The old zone is gone, but its deletion did not cascade to the CDN.
      expect(mock.storageZones.get(before.storageZoneId)!.Deleted).toBe(true);
      expect(after.pullZoneId).toBe(before.pullZoneId);
      const cdn = mock.pullZones.get(after.pullZoneId)!;
      expect(cdn.StorageZoneId).toBe(after.storageZoneId);
      const newZone = mock.storageZones.get(after.storageZoneId)!;
      expect(newZone.Region).toBe("NY");
      expect(mock.files.get(newZone.Name)!.has("index.html")).toBe(true);

      yield* stack.destroy();
      expect(mock.pullZones.has(after.pullZoneId)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "a custom hostname is added, gets a certificate, and forces SSL",
  (stack) =>
    Effect.gen(function* () {
      const dir = makeSite({ "index.html": "<h1>www</h1>" });
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Bunny.Website.StaticSite("Site", {
            outdir: dir,
            domain: "www.example.test",
          });
          return {
            url: site.url,
            pullZoneId: site.pullZone!.pullZoneId,
            hasCertificate: site.hostnames[0]!.hasCertificate,
          };
        }),
      );
      expect(out.url).toBe("https://www.example.test");
      expect(out.hasCertificate).toBe(true);
      const entry = mock.pullZones
        .get(out.pullZoneId)!
        .Hostnames.find((hostname) => hostname.Value === "www.example.test")!;
      expect(entry.HasCertificate).toBe(true);
      expect(entry.ForceSSL).toBe(true);

      // Dropping the domain removes the hostname from the pull zone.
      yield* stack.deploy(Bunny.Website.StaticSite("Site", { outdir: dir }));
      expect(
        mock.pullZones
          .get(out.pullZoneId)!
          .Hostnames.some((hostname) => hostname.Value === "www.example.test"),
      ).toBe(false);

      yield* stack.destroy();
      expect(mock.pullZones.has(out.pullZoneId)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "an existing zone with an explicit name is not adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const existing = {
        Id: 1,
        Name: "someone-elses-zone",
        Password: "x",
        ReadOnlyPassword: "y",
        Region: "DE",
        ReplicationRegions: [],
        ZoneTier: 0,
        StorageZoneType: 0,
        StorageHostname: "storage.bunnycdn.com",
        Rewrite404To200: false,
        Custom404FilePath: null,
        Deleted: false,
      };
      mock.storageZones.set(existing.Id, existing);
      mock.files.set(existing.Name, new Map());

      const result = yield* stack
        .deploy(Bunny.StorageZone("Zone", { name: "someone-elses-zone" }))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(mock.storageZones.get(existing.Id)!.Deleted).toBe(false);

      yield* stack.destroy();
      expect(mock.storageZones.get(existing.Id)!.Deleted).toBe(false);
    }),
  { timeout: 60_000 },
);

/** Deploy, expect failure, return the failure rendered as text. */
const deployFailure = <A, E, R>(
  stack: { deploy: (effect: Effect.Effect<A, E, R>) => Effect.Effect<unknown, any, any> },
  effect: Effect.Effect<A, E, R>,
) =>
  stack.deploy(effect).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
  );

test.provider(
  "an explicitly named storage zone is not replaced; the plan explains why",
  (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Bunny.StorageZone("Zone", { name: "named-zone-a", region: "DE" }),
      );
      const failure = yield* deployFailure(
        stack,
        Bunny.StorageZone("Zone", { name: "named-zone-a", region: "NY" }),
      );
      expect(failure).toContain("keeps a deleted zone's name blocked");
      const zone = mock.storageZones.get(created.storageZoneId)!;
      expect(zone.Deleted).toBe(false);
      expect(zone.Region).toBe("DE");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);

test.provider(
  "recreating a just-deleted storage zone name fails with a clear error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bunny.StorageZone("Zone", { name: "named-zone-b" }));
      yield* stack.destroy();
      const failure = yield* deployFailure(
        stack,
        Bunny.StorageZone("Zone", { name: "named-zone-b" }),
      );
      expect(failure).toContain("deleted recently");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);

/** Write an edge script entry file and return its path. */
const makeScript = (source: string) => {
  const dir = makeSite({ "edge.ts": source });
  return join(dir, "edge.ts");
};

test.provider(
  "edge script: created with code, published once, updated on change, destroyed with its pull zone",
  (stack) =>
    Effect.gen(function* () {
      const main = makeScript(`console.log("edge v1");`);
      // env routed by shape: strings → variables, Redacted → secrets.
      const program = (variables: Record<string, string>, secrets: Record<string, string>, cookies?: boolean) =>
        Bunny.EdgeScript("Api", {
          main,
          env: {
            ...variables,
            ...Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, Redacted.make(value)])),
          },
          ...(cookies === undefined ? {} : { cookies }),
        });

      const first = yield* stack.deploy(program({ GREETING: "hi" }, { TOKEN: "s1" }));
      const script = mock.scripts.get(first.scriptId)!;
      expect(script.Code).toContain("edge v1");
      expect(script.Code).not.toContain("starter code");
      expect(first.releaseId).toBeGreaterThan(0);
      expect(mock.publishes.filter((id) => id === first.scriptId).length).toBe(1);
      expect(first.url).toBe(`https://${script.LinkedPullZones[0]!.PullZoneName}.bunny.run`);
      expect(mock.pullZones.has(first.pullZoneId!)).toBe(true);
      expect(script.EdgeScriptVariables.map((v) => [v.Name, v.DefaultValue])).toEqual([["GREETING", "hi"]]);
      expect(script.Secrets.map((secret) => [secret.Name, secret.Value])).toEqual([["TOKEN", "s1"]]);
      // bunny.net creates the linked zone with cookies disabled; Alchemy enables them.
      expect(mock.pullZones.get(first.pullZoneId!)!.DisableCookies).toBe(false);
      expect(first.cookies).toBe(true);

      // Unchanged: no writes.
      const before = mock.requests.length;
      yield* stack.deploy(program({ GREETING: "hi" }, { TOKEN: "s1" }));
      expect(writesSince(before)).toEqual([]);

      // Code change: upload and publish.
      writeFileSync(main, `console.log("edge v2");`);
      yield* stack.deploy(program({ GREETING: "hi" }, { TOKEN: "s1" }));
      expect(script.Code).toContain("edge v2");
      expect(mock.publishes.filter((id) => id === first.scriptId).length).toBe(2);

      // Variable and secret changes sync; removed ones are deleted.
      yield* stack.deploy(program({ GREETING: "hello", MODE: "prod" }, {}));
      expect(Object.fromEntries(script.EdgeScriptVariables.map((v) => [v.Name, v.DefaultValue]))).toEqual({
        GREETING: "hello",
        MODE: "prod",
      });
      expect(script.Secrets).toEqual([]);
      expect(mock.publishes.filter((id) => id === first.scriptId).length).toBe(3);

      // cookies: false restores bunny.net's default without a new release.
      const noCookies = yield* stack.deploy(program({ GREETING: "hello", MODE: "prod" }, {}, false));
      expect(mock.pullZones.get(first.pullZoneId!)!.DisableCookies).toBe(true);
      expect(noCookies.cookies).toBe(false);
      expect(mock.publishes.filter((id) => id === first.scriptId).length).toBe(3);

      yield* stack.destroy();
      expect(mock.scripts.has(first.scriptId)).toBe(false);
      expect(mock.pullZones.has(first.pullZoneId!)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "edge rule: created, updated in place (no duplicate), deleted",
  (stack) =>
    Effect.gen(function* () {
      const program = (value: string) =>
        Effect.gen(function* () {
          const cdn = yield* Bunny.PullZone("Cdn", { origin: { url: "https://example.com" } });
          const rule = yield* Bunny.EdgeRule("Header", {
            pullZone: cdn,
            action: { type: "SetResponseHeader", name: "X-Alchemy", value },
            when: { url: "*/api/*" },
          });
          return { pullZoneId: cdn.pullZoneId, guid: rule.guid };
        });

      const first = yield* stack.deploy(program("one"));
      const zone = mock.pullZones.get(first.pullZoneId)!;
      expect(zone.EdgeRules.length).toBe(1);
      expect(zone.EdgeRules[0]).toMatchObject({
        Guid: first.guid,
        ActionType: 5,
        ActionParameter1: "X-Alchemy",
        ActionParameter2: "one",
        Triggers: [{ Type: 0, PatternMatches: ["*/api/*"], PatternMatchingType: 0 }],
      });

      const second = yield* stack.deploy(program("two"));
      expect(second.guid).toBe(first.guid);
      expect(zone.EdgeRules.length).toBe(1);
      expect(zone.EdgeRules[0]!.ActionParameter2).toBe("two");

      yield* stack.destroy();
      expect(mock.pullZones.has(first.pullZoneId)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "static site: asset cache rules, forced downloads, middleware attach and detach",
  (stack) =>
    Effect.gen(function* () {
      const dir = makeSite({ "index.html": "<h1>rules</h1>", "downloads/guide.txt": "guide" });
      const middlewareMain = makeScript(`console.log("middleware");`);
      const program = (withMiddleware: boolean) =>
        Effect.gen(function* () {
          const middleware = withMiddleware
            ? yield* Bunny.EdgeScript("Middleware", { main: middlewareMain, type: "middleware" })
            : undefined;
          const site = yield* Bunny.Website.StaticSite("Site", {
            outdir: dir,
            downloads: "/downloads/*",
            middleware,
          });
          return { pullZoneId: site.pullZone!.pullZoneId, scriptId: middleware?.scriptId };
        });

      const first = yield* stack.deploy(program(true));
      const zone = mock.pullZones.get(first.pullZoneId)!;
      const byAction = (actionType: number) => zone.EdgeRules.filter((rule) => rule.ActionType === actionType);
      expect(byAction(16).length).toBe(3);
      expect(byAction(16)[0]).toMatchObject({ ActionParameter1: "86400" });
      expect(byAction(16).flatMap((rule) => rule.Triggers[0].PatternMatches)).toContain("css");
      expect(byAction(7)).toMatchObject([{ Triggers: [{ Type: 0, PatternMatches: ["*/downloads/*"] }] }]);
      expect(zone.MiddlewareScriptId).toBe(first.scriptId!);
      expect(mock.scripts.get(first.scriptId!)!.LinkedPullZones).toEqual([]);

      // Unchanged: no writes.
      const before = mock.requests.length;
      yield* stack.deploy(program(true));
      expect(writesSince(before)).toEqual([]);

      // Detach and delete the middleware.
      yield* stack.deploy(program(false));
      expect(zone.MiddlewareScriptId).toBe(null);
      expect(mock.scripts.has(first.scriptId!)).toBe(false);

      yield* stack.destroy();
      expect(mock.pullZones.has(first.pullZoneId)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "edge script fetchHandler mode wraps a default-exported fetch handler with the SDK's Deno build",
  (stack) =>
    Effect.gen(function* () {
      const main = makeScript(
        `export default { fetch: (request) => new Response("framework says hi " + new URL(request.url).pathname) };`,
      );
      const out = yield* stack.deploy(Bunny.EdgeScript("App", { main, fetchHandler: true }));
      const code = mock.scripts.get(out.scriptId)!.Code;
      expect(code).toContain("framework says hi");
      expect(code).toContain("Bunny.v1.serve");
      // The Node build of the SDK starts its own HTTP server; it must not be bundled.
      expect(code).not.toContain("@hono/node-server");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);

const tablesOf = (databaseId: string) =>
  (mock.databases.get(databaseId)!.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .values() as string[][]).map(([name]) => name);

const databaseWrites = (index: number) =>
  writesSince(index).filter((request) => request.path.startsWith("/database/") || request.path.startsWith("/sql/"));

test.provider(
  "database: create with migrations and a token, no-op redeploy, new migration, region change, token replace, destroy",
  (stack) =>
    Effect.gen(function* () {
      const migrations = makeSite({
        "0001_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        "0002_posts.sql":
          "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL);\n" +
          "CREATE INDEX posts_user ON posts (user_id); -- two statements in one file",
      });
      const program = (props: { replicaRegions?: Bunny.DatabaseRegion[]; authorization?: "full-access" | "read-only" } = {}) =>
        Effect.gen(function* () {
          const db = yield* Bunny.Database("Db", {
            migrations,
            ...(props.replicaRegions ? { replicaRegions: props.replicaRegions } : {}),
          });
          const token = yield* Bunny.DatabaseToken("DbToken", {
            database: db,
            ...(props.authorization ? { authorization: props.authorization } : {}),
          });
          return {
            databaseId: db.databaseId,
            name: db.name,
            url: db.url,
            storageRegion: db.storageRegion,
            replicaRegions: db.replicaRegions,
            token: token.token,
            authorization: token.authorization,
          };
        });

      // 1. Create: generated slug name, storage region from the primary region's group,
      //    both migrations applied (the second file holds two statements), a working token.
      const first = yield* stack.deploy(program());
      const db = mock.databases.get(first.databaseId)!;
      expect(first.name).toMatch(/^db-[a-z0-9]{8}$/);
      expect(first.storageRegion).toBe("eu-west-1");
      expect(db.primary_regions).toEqual(["DE"]);
      expect(tablesOf(first.databaseId)).toEqual(["__alchemy_migrations", "posts", "users"]);
      expect(Redacted.isRedacted(first.token)).toBe(true);
      expect(db.tokens.get(Redacted.value(first.token))?.authorization).toBe("full-access");

      // 2. Redeploy with nothing changed: no database writes at all.
      const before = mock.requests.length;
      const second = yield* stack.deploy(program());
      expect(second.databaseId).toBe(first.databaseId);
      expect(Redacted.value(second.token)).toBe(Redacted.value(first.token));
      expect(databaseWrites(before)).toEqual([]);

      // 3. A new migration is applied on its own; the token is kept.
      writeFileSync(join(migrations, "0003_tags.sql"), "CREATE TABLE tags (name TEXT PRIMARY KEY);");
      const third = yield* stack.deploy(program());
      expect(tablesOf(first.databaseId)).toContain("tags");
      expect(
        (db.sqlite.prepare("SELECT count(*) AS n FROM __alchemy_migrations").get() as { n: number }).n,
      ).toBe(3);
      expect(Redacted.value(third.token)).toBe(Redacted.value(first.token));

      // 4. Replica regions change in place.
      const fourth = yield* stack.deploy(program({ replicaRegions: ["UK"] }));
      expect(fourth.databaseId).toBe(first.databaseId);
      expect(db.replicas_regions).toEqual(["UK"]);

      // 5. A read-only token replaces the full-access one.
      const fifth = yield* stack.deploy(program({ replicaRegions: ["UK"], authorization: "read-only" }));
      expect(Redacted.value(fifth.token)).not.toBe(Redacted.value(first.token));
      expect(db.tokens.get(Redacted.value(fifth.token))?.authorization).toBe("read-only");

      // 6. Destroy removes the database.
      yield* stack.destroy();
      expect(mock.databases.has(first.databaseId)).toBe(false);
    }),
  { timeout: 60_000 },
);

test.provider(
  "database: a failing migration applies nothing and is retried on the next deploy",
  (stack) =>
    Effect.gen(function* () {
      const migrations = makeSite({
        "0001_ok.sql": "CREATE TABLE ok (x INTEGER);",
        "0002_bad.sql": "CREATE TABLE half (x INTEGER);\nINSERT INTO missing VALUES (1);",
      });
      const program = Bunny.Database("Db", { migrations });

      const failed = yield* stack.deploy(program).pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
      );
      expect(failed).toContain("missing");
      const [db] = [...mock.databases.values()];
      expect(tablesOf(db!.id)).toEqual(["__alchemy_migrations", "ok"]);

      writeFileSync(join(migrations, "0002_bad.sql"), "CREATE TABLE half (x INTEGER);");
      yield* stack.deploy(program);
      expect(tablesOf(db!.id)).toEqual(["__alchemy_migrations", "half", "ok"]);

      yield* stack.destroy();
      expect(mock.databases.size).toBe(0);
    }),
  { timeout: 60_000 },
);

test.provider(
  "database: changing the storage region of a named database replaces it",
  (stack) =>
    Effect.gen(function* () {
      const deploy = (storageRegion: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const db = yield* Bunny.Database("Db", { name: "notes", storageRegion });
            return { databaseId: db.databaseId, storageRegion: db.storageRegion };
          }),
        );
      const first = yield* deploy("eu-west-1");
      const second = yield* deploy("us-east-1");
      expect(second.databaseId).not.toBe(first.databaseId);
      expect(second.storageRegion).toBe("us-east-1");
      expect(mock.databases.has(first.databaseId)).toBe(false);
      expect([...mock.databases.values()].map((db) => db.name)).toEqual(["notes"]);

      yield* stack.destroy();
      expect(mock.databases.size).toBe(0);
    }),
  { timeout: 60_000 },
);

test.provider(
  "database: a failed create or token mint is sent once, not retried",
  (stack) =>
    Effect.gen(function* () {
      const database = Bunny.Database("Db", {});
      const databasesBefore = mock.databases.size;

      // bunny.net answers client errors on this API with 500; a lost response
      // looks the same to the client. Neither may re-send the create.
      mock.failNext("POST", "/database/v2/databases", 500);
      let since = mock.requests.length;
      const failure = yield* deployFailure(stack, database);
      expect(failure).not.toBe("");
      const creates = mock.requests.slice(since).filter(
        (request) => request.method === "POST" && request.path === "/database/v2/databases",
      );
      expect(creates.length).toBe(1);
      expect(mock.databases.size).toBe(databasesBefore);

      // The next deploy creates it, once.
      yield* stack.deploy(database);
      expect(mock.databases.size).toBe(databasesBefore + 1);

      // A token mint is not re-sent either: a second token would be valid and unheld.
      mock.failNext("PUT", /\/auth\/generate$/, 500);
      since = mock.requests.length;
      const tokenFailure = yield* deployFailure(
        stack,
        Effect.gen(function* () {
          const db = yield* database;
          yield* Bunny.DatabaseToken("Token", { database: db });
        }),
      );
      expect(tokenFailure).not.toBe("");
      const mints = mock.requests.slice(since).filter(
        (request) => request.method === "PUT" && /\/auth\/generate$/.test(request.path),
      );
      expect(mints.length).toBe(1);

      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);

test.provider(
  "database: an existing database with an explicit name is not adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const create = yield* Effect.promise(() =>
        fetch(`${mock.url}/database/v2/databases`, {
          method: "POST",
          headers: { AccessKey: ACCOUNT_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "theirs", storage_region: "eu-west-1", primary_regions: ["DE"], replicas_regions: [] }),
        }).then((response) => response.json() as Promise<{ db_id: string }>),
      );
      const failure = yield* stack.deploy(Bunny.Database("Db", { name: "theirs" })).pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
      );
      expect(failure).toContain("OwnedBySomeoneElse");
      expect(mock.databases.has(create.db_id)).toBe(true);

      yield* stack.destroy();
      expect(mock.databases.has(create.db_id)).toBe(true);
      mock.databases.delete(create.db_id);
    }),
  { timeout: 60_000 },
);

const columnsOf = (databaseId: string, table: string) =>
  (mock.databases.get(databaseId)!.sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).values() as string[][]).map(
    ([name]) => name,
  );

test.provider(
  "better auth (stock): BetterAuth() in an Effect-native EdgeScript migrates at deploy and binds db, token and secret",
  (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AuthApi;
          return { scriptId: api.scriptId };
        }),
      );

      // The stock migration Action created Better Auth's tables (plus the
      // extra field) in the Bunny Database before the script deployed.
      const [db] = [...mock.databases.values()];
      expect(tablesOf(db!.id)).toEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
      expect(columnsOf(db!.id, "user")).toContain("nickname");

      // Bindings: the database URL as a variable; the token and the
      // generated signing secret as secrets; the runtime variables.
      const script = mock.scripts.get(out.scriptId)!;
      const variables = Object.fromEntries(script.EdgeScriptVariables.map((v) => [v.Name, v.DefaultValue]));
      expect(variables.ALCHEMY_PHASE).toBe("runtime");
      expect(Object.values(variables)).toContain(`${mock.url}/sql/${db!.id}/`);
      const secrets = script.Secrets.map((secret) => secret.Name).sort();
      expect(secrets.some((name) => /BetterAuthSecret/.test(name))).toBe(true);
      expect(secrets.some((name) => /AuthDbQueryDatabaseToken/.test(name))).toBe(true);
      // The bundle is the generated entry around the class (the bootstrap).
      expect(script.Code).toContain("Bunny Edge Script bootstrap failed");
      // The deploy-time migration client (QueryDatabaseLocal, which mints
      // tokens with the account key) is not in the bundle.
      expect(script.Code).not.toContain("generateDatabaseToken");

      // Unchanged: the migration does not run again.
      const before = mock.requests.length;
      yield* stack.deploy(Effect.gen(function* () {
        yield* AuthApi;
      }));
      expect(databaseWrites(before)).toEqual([]);

      yield* stack.destroy();
      expect(mock.scripts.has(out.scriptId)).toBe(false);
    }),
  { timeout: 120_000 },
);

const envOf = (scriptId: number) => {
  const script = mock.scripts.get(scriptId)!;
  return {
    variables: Object.fromEntries(script.EdgeScriptVariables.map((v) => [v.Name, v.DefaultValue])),
    secrets: Object.fromEntries(script.Secrets.map((secret) => [secret.Name, secret.Value])),
  };
};

/** A secret bound through `RuntimeContext.set` holds the packed Redacted marker. */
const unpackSecret = (value: string | undefined) => {
  const unpacked = unpackEnvValue<Redacted.Redacted<string>>(value);
  return unpacked === undefined ? undefined : Redacted.value(unpacked);
};

test.provider(
  "capabilities: ReadStorageZone, ReadWriteStorageZone and QueryDatabase bind the zone and a database token into an EdgeScript",
  (stack) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const api = yield* CapabilityApi;
        const files = yield* Files;
        const db = yield* CapabilityDb;
        return { scriptId: api.scriptId, storageZoneId: files.storageZoneId, databaseId: db.databaseId, url: db.url };
      });
      const out = yield* stack.deploy(program);
      const zone = mock.storageZones.get(out.storageZoneId)!;
      const { variables, secrets } = envOf(out.scriptId);

      // Storage: host and name as variables; Read gets the read-only
      // password, ReadWrite the full one, both as secrets.
      expect(variables.Files_storageHostname).toBe("storage.bunnycdn.com");
      expect(variables.Files_name).toBe(zone.Name);
      expect(unpackSecret(secrets.Files_readOnlyPassword)).toBe(zone.ReadOnlyPassword);
      expect(unpackSecret(secrets.Files_password)).toBe(zone.Password);

      // Database: the URL, and a full-access token the binding issued.
      expect(variables.Db_url).toBe(out.url);
      const token = unpackSecret(secrets.DbQueryDatabaseToken_token)!;
      expect(mock.databases.get(out.databaseId)!.tokens.get(token)?.authorization).toBe("full-access");

      // Unchanged: no writes.
      const before = mock.requests.length;
      yield* stack.deploy(program);
      expect(writesSince(before)).toEqual([]);

      yield* stack.destroy();
      expect(mock.scripts.has(out.scriptId)).toBe(false);
    }),
  { timeout: 120_000 },
);

test.provider(
  "fetch: a caller binds the callee's key onto both sides, updates an already deployed callee, and removing callers removes it",
  (stack) =>
    Effect.gen(function* () {
      const plainMain = makeScript(`console.log("plain caller");`);
      const deploy = (callers: { effect?: boolean; plain?: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const callee = yield* Callee;
            const caller = callers.effect ? yield* Caller : undefined;
            // Inside a namespace, like a composite: the key must still be
            // the callee's one (declared at the callee's namespace).
            const plain = callers.plain
              ? yield* Bunny.EdgeScript("Plain", { main: plainMain, env: { CALLEE: callee } }).pipe(
                  Namespace.push("Site"),
                )
              : undefined;
            return { callee: callee.scriptId, calleeUrl: callee.url, caller: caller?.scriptId, plain: plain?.scriptId };
          }),
        );

      // 1. The callee alone has no key.
      const first = yield* deploy({});
      expect(envOf(first.callee).secrets.ALCHEMY_FETCH_KEY).toBeUndefined();

      // 2. Adding an Effect-native caller updates the deployed callee.
      const second = yield* deploy({ effect: true });
      expect(second.callee).toBe(first.callee);
      const key = envOf(second.callee).secrets.ALCHEMY_FETCH_KEY!;
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      const caller = envOf(second.caller!);
      expect(caller.variables.Callee_url).toBe(second.calleeUrl!);
      expect(unpackSecret(caller.secrets.CalleeFetchKey_text)).toBe(key);

      // 3. A plain caller's env binding gets the same key.
      const third = yield* deploy({ effect: true, plain: true });
      const plain = envOf(third.plain!);
      expect(plain.variables.CALLEE_URL).toBe(third.calleeUrl!);
      expect(plain.secrets.CALLEE_KEY).toBe(key);
      expect(envOf(third.callee).secrets.ALCHEMY_FETCH_KEY).toBe(key);
      // (Had the namespaced caller declared its own key, the callee would get
      // two values and the deploy would fail with EdgeScriptEnvConflict.)

      // 4. Without callers the key leaves the callee.
      const fourth = yield* deploy({});
      expect(envOf(fourth.callee).secrets.ALCHEMY_FETCH_KEY).toBeUndefined();
      expect(mock.scripts.has(third.caller!)).toBe(false);
      expect(mock.scripts.has(third.plain!)).toBe(false);

      yield* stack.destroy();
      expect(mock.scripts.has(first.callee)).toBe(false);
    }),
  { timeout: 120_000 },
);

test.provider(
  "fetch: a class caller inside a namespace binds the callee instance its init yields, with that callee's key",
  (stack) =>
    Effect.gen(function* () {
      const plainMain = makeScript(`console.log("root caller");`);
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const callee = yield* Callee;
          // The caller's init yields `Callee` inside `App`, which declares
          // `App/Callee` (Alchemy's class-tag semantics); its key is
          // `App/CalleeFetchKey`, the root callee's stays `CalleeFetchKey`.
          const caller = yield* Caller.pipe(Namespace.push("App"));
          const plain = yield* Bunny.EdgeScript("Plain", { main: plainMain, env: { CALLEE: callee } });
          return { callee: callee.scriptId, caller: caller.scriptId, plain: plain.scriptId };
        }),
      );
      const rootKey = envOf(out.callee).secrets.ALCHEMY_FETCH_KEY!;
      expect(envOf(out.plain).secrets.CALLEE_KEY).toBe(rootKey);
      const callerKey = unpackSecret(envOf(out.caller).secrets.CalleeFetchKey_text)!;
      expect(callerKey).toMatch(/^[0-9a-f]{64}$/);
      expect(callerKey).not.toBe(rootKey);
      const namespacedCallee = [...mock.scripts.values()].find(
        (script) => script.Id !== out.callee && script.Secrets.some((secret) => secret.Name === "ALCHEMY_FETCH_KEY"),
      )!;
      expect(namespacedCallee.Secrets.find((secret) => secret.Name === "ALCHEMY_FETCH_KEY")!.Value).toBe(callerKey);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "edge script env: a binding may not set a name the script's props set",
  (stack) =>
    Effect.gen(function* () {
      const main = makeScript(`console.log("target");`);
      const failure = yield* stack
        .deploy(
          Effect.gen(function* () {
            const target = yield* Bunny.EdgeScript("Target", { main, env: { ALCHEMY_FETCH_KEY: "mine" } });
            yield* Bunny.EdgeScript("Source", { main, env: { TARGET: target } });
          }),
        )
        .pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
        );
      expect(failure).toContain("env.ALCHEMY_FETCH_KEY is set by the script's props and by the binding");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
