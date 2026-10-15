# Bindings

Bindings give running code typed access to bunny.net resources. They are Alchemy **capabilities** (`Binding.Service`s), built the way Alchemy's own `Cloudflare.R2` and `Cloudflare.D1` capabilities are, and they work in an Effect-native `Bunny.EdgeScript` or any other Alchemy host with a runtime context.

| Capability | Provide | The host gets | Client |
| --- | --- | --- | --- |
| `ReadStorageZone(zone)` | `ReadStorageZoneHttp` | storage host, zone name, **read-only** password (secret) | `get`, `list`, `listFiles` |
| `WriteStorageZone(zone)` | `WriteStorageZoneHttp` | host, name, password (secret) | `put`, `delete` |
| `ReadWriteStorageZone(zone)` | `ReadWriteStorageZoneHttp` | host, name, password (secret) | all of the above |
| `QueryDatabase(db)` | `QueryDatabaseHttp` (scripts); `QueryDatabaseLocal` (deploy-time Actions) | database URL, a full-access token (secret) | `prepare().bind().all/first/run/raw`, `exec`, `batch`, `raw` |
| `FetchEdgeScript(script)` | `FetchEdgeScriptHttp` | the callee's URL and key (secret); the callee gets the key | `(HttpClientRequest) => HttpClientResponse` |

## How they work

A capability is called in the host's init, as in `yield* Bunny.ReadStorageZone(zone)`, and returns a client whose methods run at request time. Provide the implementation layer on the host's effect.

bunny.net has no native bindings, so, like Alchemy's Stripe and Prisma capabilities, a capability **yields the resource's Outputs** during init: `RuntimeContext.set` binds them into whichever host runs it (`Redacted` values as secrets) and the client reads them back at runtime. It does not call `host.bind`, which is why the same capability works on every host. Credentials a capability needs are resources named after the *bound resource*, not the host (`<db>QueryDatabaseToken`, `<script>FetchKey`), so every host binding one resource shares one credential.

## Storage zones

```ts
export const Uploads = Bunny.StorageZone("Uploads", {});

export default class Files extends Bunny.EdgeScript<Files>()(
  "Files",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Bunny.ReadWriteStorageZone(yield* Uploads);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const key = new URL(request.url).pathname.slice(1);
        if (request.method === "PUT") {
          yield* uploads.put(key, new Uint8Array(yield* request.arrayBuffer));
          return HttpServerResponse.empty({ status: 201 });
        }
        const file = yield* uploads.get(key);
        return file === null
          ? HttpServerResponse.text("Not Found", { status: 404 })
          : HttpServerResponse.uint8Array(file.body, { contentType: file.contentType ?? undefined });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.ReadWriteStorageZoneHttp)),
) {}
```

| Method | Returns |
| --- | --- |
| `get(key)` | `{ key, body: Uint8Array, contentType, etag, lastModified }`, or `null` when missing |
| `list(directory = "")` | one directory level: files, and directories (keys ending in `/`); a missing directory lists as empty |
| `listFiles(prefix = "")` | every file under `prefix`, recursively |
| `put(key, body, { contentType? })` | `void`; `body` is a `Uint8Array` or a string; parent directories are created |
| `delete(key)` | `void`; a key ending in `/` deletes the directory and its contents; deleting something missing succeeds |

Errors are typed `StorageError`s (`StorageUnauthorized`, `StorageNotFound`, `StorageBadRequest`, `StorageThrottled`, …); throttling and 5xx are retried.

- `ReadStorageZone` binds the zone's read-only password: bunny.net serves GET and listings with it and answers PUT and DELETE with 401. bunny.net has no write-only password, so `WriteStorageZone` binds the full one and its client simply has no reads.
- There is no `head`: the Edge Storage API rejects `HEAD` (401, even with the full password).
- Bodies are buffered: `get` reads the whole file into memory and `put` takes bytes; there is no streaming yet ([Known limitations](limitations.md)).

## Databases

```ts
export const Db = Bunny.Database("Db", { migrations: "./migrations" });

export default class Notes extends Bunny.EdgeScript<Notes>()(
  "Notes",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        const { results } = yield* db
          .prepare("SELECT id, body FROM notes ORDER BY id DESC LIMIT ?")
          .bind(20)
          .all<{ id: number; body: string }>();
        return yield* HttpServerResponse.json(results);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.QueryDatabaseHttp)),
) {}
```

The client mirrors `Cloudflare.D1.QueryDatabase`: `prepare(sql).bind(...values)` builds a statement without I/O, and `all`, `first(column?)`, `run` and `raw({ columnNames? })` execute it; `exec(sql)` runs one or more statements; `batch(statements)` runs them in one transaction (a failure keeps none). `raw` is a D1-compatible connection for libraries that take a D1 binding (Better Auth, `drizzle-orm/d1`). Errors are a typed `DatabaseQueryError`. There are no interactive transactions, as with D1 over HTTP.

`QueryDatabaseHttp` issues one full-access `DatabaseToken` per database (`<db>QueryDatabaseToken`, no expiry). **Read [Token revocation](database.md#token-revocation)** before relying on revoking tokens.

In a deploy-time `Alchemy.Action`, provide `QueryDatabaseLocal` instead: it binds nothing and issues a 15-minute token with your account credentials at apply time.

```ts
export const Seed = Alchemy.Action(
  "Seed",
  Effect.gen(function* () {
    const db = yield* Bunny.QueryDatabase(yield* Db);
    return Effect.fn(function* () {
      yield* db.prepare("INSERT INTO notes (body) VALUES (?)").bind("hello").run();
    });
  }).pipe(Effect.provide(Bunny.QueryDatabaseLocal)),
);
```

## Edge Script to Edge Script

`FetchEdgeScript` is the counterpart of a Cloudflare service binding (`Cloudflare.Workers.Fetch`): the callee handles each request as the URL the caller addressed, with its origin, path, query and cookies, not as its own `*.bunny.run` URL. A site forwarding `/api/auth/*` to an auth script this way keeps the browser on one origin, and the auth script sees the site's origin.

```ts
export default class Gateway extends Bunny.EdgeScript<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Effect.gen(function* () {
    const auth = yield* Bunny.FetchEdgeScript(yield* Auth);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = yield* auth(HttpClientRequest.get(request.url)); // Auth sees this URL
        return HttpServerResponse.fromClientResponse(response);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.FetchEdgeScriptHttp)),
) {}
```

**Non-Effect callers** (a framework server, a bundled script) bind the callee through `env` and call it with `edgeScriptFetcher`:

```ts
// alchemy.run.ts
const site = yield* Bunny.EdgeScript("Site", { main: "./site.ts", fetchHandler: true, env: { AUTH: auth } });

// site.ts: AUTH becomes AUTH_URL + AUTH_KEY
import { edgeScriptFetcher } from "alchemy-bunny/EdgeScriptFetch";

const auth = edgeScriptFetcher("AUTH");
export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname.startsWith("/auth/") ? auth.fetch(request) : new Response("site"),
};
```

`Website.TanStackStart`'s `env` accepts Edge Scripts the same way. `alchemy-bunny/EdgeScriptFetch` has no dependencies, so it is safe in any bundle.

**How it works.** bunny.net has no service bindings, so the call goes over HTTPS to the callee's URL with two headers: `x-alchemy-forwarded-url` (the original URL) and `x-alchemy-fetch-key`. The key is an `Alchemy.Random` per callee (`<Callee>FetchKey`, declared in the callee's namespace so every caller shares it), bound onto the callee as `ALCHEMY_FETCH_KEY` through its Binding Contract. The callee's runtime honours the forwarded URL only with the right key (compared without early exit) and strips both headers from **every** request, so the URL cannot be spoofed without the key.

- The callee must be an **Effect-native** `Bunny.EdgeScript`: its runtime does the re-addressing. A bundled or `fetchHandler` script as the callee receives its own URL.
- Redirects are returned to the caller, not followed.
- The re-addressing has no counterpart in Alchemy itself: Neon's `InvokeFunction`, the closest one, is URL-only. It exists because an auth service behind a site must see the site's origin.

## Non-Effect code

Code that cannot `yield*` a capability, such as a framework server or a bundled script, gets values through `env`, as with Alchemy's Neon and Prisma resources: pass attribute Outputs (`BUNNY_DATABASE_URL: db.url`, `BUNNY_DATABASE_AUTH_TOKEN: token.token`, `zone.password`, …) and use a client directly: `@bunny.net/database-client` or `alchemy-bunny/DatabaseD1` for the database, and `fetch` for Edge Storage (`PUT https://<host>/<zone>/<path>` with `AccessKey: <password>`). The one addition is an Edge Script in `env`, above.

## Verification

Mock-backed lifecycle and client tests cover every capability (`packages/bunny/test/provider.test.ts`, `capabilities.test.ts`). Live on bunny.net (`live.test.ts`, 2026-09-29): an Edge Script writing and reading a storage zone and querying a database through these bindings, and a `FetchEdgeScript` call handled as the caller's URL while unkeyed and wrong-key requests keep the callee's own URL. The [TanStack Start example](../examples/tanstack-start)'s Better Auth flow (sign-up, sign-in, sessions, CSRF, forged-URL refusal) was verified end to end through an `env` binding on a live deployment.
