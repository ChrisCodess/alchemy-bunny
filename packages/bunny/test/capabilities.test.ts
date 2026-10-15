/**
 * Runtime halves of the capabilities: the clients `ReadStorageZoneHttp`,
 * `ReadWriteStorageZoneHttp` and `QueryDatabaseHttp` build, run against the
 * in-memory bunny.net in `mock-bunny.ts`, and the Edge Script forwarding
 * `FetchEdgeScript` and `env` bindings rely on, through the real runtime
 * context. The deploy halves (what gets bound where) are covered by
 * `provider.test.ts`; the live tests cover bunny.net itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { connectD1 } from "../src/DatabaseD1.ts";
import {
  edgeScriptFetcher,
  FETCH_KEY_ENV,
  FETCH_KEY_HEADER,
  FORWARDED_URL_HEADER,
  fromForwardedRequest,
  toForwardedRequest,
} from "../src/EdgeScriptFetch.ts";
import { makeEdgeScriptRuntimeContext } from "../src/EdgeScriptRuntime.ts";
import { makeQueryDatabaseClient } from "../src/QueryDatabase.ts";
import { makeReadStorageZoneClient } from "../src/ReadStorageZoneHttp.ts";
import { makeReadWriteStorageZoneClient } from "../src/ReadWriteStorageZoneHttp.ts";
import { makeStorageZoneHttpClient } from "../src/StorageZoneHttp.ts";
import { makeWriteStorageZoneClient } from "../src/WriteStorageZoneHttp.ts";
import { ACCOUNT_KEY, startMockBunny } from "./mock-bunny.ts";

const mock = startMockBunny();
afterAll(() => mock.stop());

const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: { AccessKey: ACCOUNT_KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect as Effect.Effect<A, E>);
const runExit = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromiseExit(effect as Effect.Effect<A, E>);

describe("Edge Script forwarding", () => {
  const key = "k".repeat(64);
  const callee = "https://callee-abc.bunny.run";

  test("the callee handles a keyed request as the original URL, with body and headers", async () => {
    const original = new Request("https://site.example/api/auth/sign-in?x=1", {
      method: "POST",
      headers: { cookie: "a=b", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    const sent = toForwardedRequest(original, undefined, { url: callee, key });
    expect(sent.url).toBe(`${callee}/api/auth/sign-in?x=1`);
    expect(sent.headers.get(FORWARDED_URL_HEADER)).toBe(original.url);
    expect(sent.redirect).toBe("manual");

    const received = fromForwardedRequest(sent, key);
    expect(received.url).toBe("https://site.example/api/auth/sign-in?x=1");
    expect(received.method).toBe("POST");
    expect(received.headers.get("cookie")).toBe("a=b");
    expect(received.headers.get(FORWARDED_URL_HEADER)).toBeNull();
    expect(received.headers.get(FETCH_KEY_HEADER)).toBeNull();
    expect(await received.json()).toEqual({ email: "a@example.com" });
  });

  test("a wrong or missing key keeps the request's own URL and strips the headers", () => {
    const spoofed = (headers: Record<string, string>) =>
      fromForwardedRequest(new Request(`${callee}/admin`, { headers }), key);
    for (const request of [
      spoofed({ [FORWARDED_URL_HEADER]: "https://site.example/admin", [FETCH_KEY_HEADER]: "x".repeat(64) }),
      spoofed({ [FORWARDED_URL_HEADER]: "https://site.example/admin" }),
      fromForwardedRequest(
        new Request(`${callee}/admin`, {
          headers: { [FORWARDED_URL_HEADER]: "https://site.example/admin", [FETCH_KEY_HEADER]: key },
        }),
        undefined, // the callee has no key bound
      ),
    ]) {
      expect(request.url).toBe(`${callee}/admin`);
      expect(request.headers.get(FORWARDED_URL_HEADER)).toBeNull();
      expect(request.headers.get(FETCH_KEY_HEADER)).toBeNull();
    }
  });

  test("the Effect-native runtime re-addresses keyed requests before the handler", async () => {
    const saved = process.env[FETCH_KEY_ENV];
    process.env[FETCH_KEY_ENV] = key;
    try {
      const ctx = makeEdgeScriptRuntimeContext("Callee");
      await run(
        ctx.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const web = request.source as Request;
            return yield* HttpServerResponse.json({ url: web.url, forwarded: web.headers.get(FORWARDED_URL_HEADER) });
          }),
        ),
      );
      const handler = await run(Effect.flatMap(ctx.exports, (exports) => exports.fetch));
      const fetcher = edgeScriptFetcher("CALLEE", { CALLEE_URL: callee, CALLEE_KEY: key });
      // Route the fetcher's request straight into the handler.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((request: Request) => handler(request)) as typeof fetch;
      try {
        const keyed = await fetcher.fetch(new Request("https://site.example/api/auth/get-session"));
        expect(await keyed.json()).toEqual({ url: "https://site.example/api/auth/get-session", forwarded: null });
      } finally {
        globalThis.fetch = originalFetch;
      }
      const direct = await handler(new Request(`${callee}/x`, { headers: { [FORWARDED_URL_HEADER]: "https://evil.example/" } }));
      expect(await direct.json()).toEqual({ url: `${callee}/x`, forwarded: null });
    } finally {
      if (saved === undefined) delete process.env[FETCH_KEY_ENV];
      else process.env[FETCH_KEY_ENV] = saved;
    }
  });

  test("edgeScriptFetcher fails clearly without its env", async () => {
    await expect(edgeScriptFetcher("NOPE", {}).fetch("/")).rejects.toThrow("NOPE_URL or NOPE_KEY");
  });
});

describe("storage zone clients", () => {
  const http = Effect.runSync(Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer));
  const zoneAccess = async () => {
    const zone = await api<{ Name: string; Password: string; ReadOnlyPassword: string }>("POST", "/storagezone", {
      Name: `caps-${crypto.randomUUID().slice(0, 8)}`,
      Region: "DE",
    });
    const access = (password: string) =>
      Effect.succeed({
        hostname: "storage.bunnycdn.com",
        zoneName: zone.Name,
        password: Redacted.make(password),
        endpoint: mock.url,
      });
    return {
      readWrite: makeReadWriteStorageZoneClient(makeStorageZoneHttpClient(access(zone.Password), http)),
      read: makeReadStorageZoneClient(makeStorageZoneHttpClient(access(zone.ReadOnlyPassword), http)),
      writeWithReadOnly: makeWriteStorageZoneClient(makeStorageZoneHttpClient(access(zone.ReadOnlyPassword), http)),
    };
  };

  test("read-write: put, get with metadata, list, list recursively, delete", async () => {
    const { readWrite } = await zoneAccess();
    await run(readWrite.put("/docs/a.txt", "hello", { contentType: "text/plain" }));
    await run(readWrite.put("docs/deep/b.bin", new Uint8Array([1, 2, 3])));

    const file = await run(readWrite.get("docs/a.txt"));
    expect(file?.key).toBe("docs/a.txt");
    expect(new TextDecoder().decode(file!.body)).toBe("hello");
    expect(file?.contentType).toBe("text/plain");
    expect(file?.etag).toBeString();
    expect(file?.lastModified).toBeInstanceOf(Date);
    expect(await run(readWrite.get("missing.txt"))).toBeNull();

    expect((await run(readWrite.list("docs"))).map((entry) => entry.key).sort()).toEqual(["docs/a.txt", "docs/deep/"]);
    expect((await run(readWrite.listFiles("docs"))).map((entry) => entry.key).sort()).toEqual([
      "docs/a.txt",
      "docs/deep/b.bin",
    ]);

    await run(readWrite.delete("docs/a.txt"));
    await run(readWrite.delete("docs/a.txt")); // missing is success
    expect(await run(readWrite.get("docs/a.txt"))).toBeNull();
  });

  test("read-only password: reads work, writes are rejected by bunny.net", async () => {
    const { readWrite, read, writeWithReadOnly } = await zoneAccess();
    await run(readWrite.put("a.txt", "hi"));
    expect(new TextDecoder().decode((await run(read.get("a.txt")))!.body)).toBe("hi");
    expect((await run(read.list())).map((entry) => entry.key)).toEqual(["a.txt"]);

    const exit = await runExit(writeWithReadOnly.put("b.txt", "no"));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("StorageUnauthorized");
  });
});

describe("QueryDatabase client", () => {
  test("prepare/bind/run/all/first/raw, exec, batch, and typed errors over Hrana", async () => {
    const { db_id } = await api<{ db_id: string }>("POST", "/database/v2/databases", {
      name: "caps",
      storage_region: "eu-west-1",
      primary_regions: ["DE"],
      replicas_regions: [],
    });
    const { db } = await api<{ db: { url: string } }>("GET", `/database/v2/databases/${db_id}`);
    const { token } = await api<{ token: string }>("PUT", `/database/v2/databases/${db_id}/auth/generate`, {
      authorization: "full-access",
    });
    const client = makeQueryDatabaseClient(Effect.sync(() => connectD1({ url: db.url, authToken: token })));

    await run(client.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"));
    const inserted = await run(client.prepare("INSERT INTO notes (body) VALUES (?)").bind("first").run());
    expect(inserted.meta.changes).toBe(1);
    await run(
      client.batch([
        client.prepare("INSERT INTO notes (body) VALUES (?)").bind("second"),
        client.prepare("INSERT INTO notes (body) VALUES (?)").bind("third"),
      ]),
    );
    const { results } = await run(client.prepare("SELECT body FROM notes ORDER BY id").all<{ body: string }>());
    expect(results.map((row) => row.body)).toEqual(["first", "second", "third"]);
    expect(await run(client.prepare("SELECT count(*) AS n FROM notes").first<number>("n"))).toBe(3);
    expect(await run(client.prepare("SELECT id FROM notes WHERE body = ?").bind("nope").first())).toBeNull();
    expect(await run(client.prepare("SELECT body FROM notes WHERE id = 1").raw())).toEqual([["first"]]);

    // A failing batch keeps nothing (one transaction).
    const failed = await runExit(
      client.batch([
        client.prepare("INSERT INTO notes (body) VALUES (?)").bind("fourth"),
        client.prepare("INSERT INTO missing VALUES (1)"),
      ]),
    );
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("DatabaseQueryError");
    expect(await run(client.prepare("SELECT count(*) AS n FROM notes").first<number>("n"))).toBe(3);
  });
});
