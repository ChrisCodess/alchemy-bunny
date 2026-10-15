# bunny.net API notes

Behaviour of the bunny.net APIs that the provider depends on. Each item was confirmed against the live APIs (2026-09-29) with probes or `packages/bunny/test/live.test.ts`; the mock in `packages/bunny/test/mock-bunny.ts` is calibrated to it. Useful if you work on the provider, or on anything else that talks to bunny.net.

## Core API

- `https://api.bunny.net` with the `AccessKey` header.
- 404 bodies are `{ ErrorKey, Field, Message }`.
- A taken name is a 400 whose message says so.
- Recreating a just-deleted storage zone's name is a 400, "The storage zone is currently being deleted.", still returned 40 minutes after the delete. Pull zone names are free again immediately.
- `GET /storagezone` ignores `search` and returns every zone as a plain array. `GET /pullzone?search=` answers with the page envelope.
- `POST /pullzone` and edge rule `addOrUpdate` return bodies, although the spec declares none.
- `DELETE /storagezone` defaults to `deleteLinkedPullZones=true`, which would also delete the CDN. The provider always sends `false`.
- Every new pull zone is created with `DisableCookies: true`: `Cookie` and `Set-Cookie` are stripped.
- The pull zone default browser cache is `max-age=2592000`.

## Edge Storage

- `https://<StorageHostname>/<zone>/<path>` with `AccessKey: <zone password>`.
- The zone's `ReadOnlyPassword`:
  - GET and listings → 200, a missing file → 404 `{"HttpCode":404,"Message":"Object Not Found"}`;
  - PUT and DELETE → 401 `Unauthorized`.
- `HEAD` → 401 even with the full password.
- GET returns `Content-Type` (from the extension, or `Override-Content-Type` at upload), `Content-Length`, `Last-Modified` and `ETag`.
- DELETE of a missing file → 404.
- Listings are one level deep. Each entry's `Checksum` is the uppercase SHA-256 of the content; a wrong `Checksum` header on upload → 400 "Checksum missmatch".
- Per-file `Cache-Control` on upload is ignored; the pull zone sets it.
- `/about` and `/about/` serve `about/index.html`.
- SPA fallback is `Rewrite404To200` plus `Custom404FilePath: /index.html`. For `Custom404FilePath`, `null` is ignored and `""` clears it.

## Edge Scripting

- A standalone script with `CreateLinkedPullZone` gets a pull zone (OriginType 4, `RoutingFilters: ["scripting"]`) on `https://<name>-<suffix>.bunny.run`.
- Create scripts **with** `Code`; otherwise bunny.net's starter code serves briefly.
- The runtime is Deno-based:
  - available: `AsyncLocalStorage` (`node:async_hooks`), `node:stream`, `node:buffer`, the globals `process` and `Buffer`, and `Deno.env.get`;
  - builtins must use the `node:` prefix;
  - `node:child_process`, `worker_threads`, `v8`, `tty`, `cluster`, `vm` and `inspector` cannot be loaded ("failed to resolve module").
- Limits: 10 MB script, 128 MB memory, 500 ms startup, 30 s CPU.
- A new release takes about 20 s to reach every isolate.
- `X-Forwarded-Host` is kept; `X-Forwarded-Proto` is appended to (`"https, https"`).
- Custom request headers such as `x-alchemy-forwarded-url` reach the script unchanged.
- Variables and secrets are both read with `process.env`; secrets cannot be read back through the API.

## Bunny Database

- API `https://api.bunny.net/database` (v2), `AccessKey` auth. No key → 401 `{"error":"Authentification issues"}`; a bad key → 401 `{"error":"Invalid AccessKey"}`.
- Errors are JSON `{ error, details? }`; query-string and path parse errors are `text/plain` 400.
- Create: `POST /v2/databases { name, storage_region, primary_regions, replicas_regions }` → `{ db_id }`.
  - `storage_region` is `eu-west-1` or `us-east-1` (from `GET /v1/config`); `"DE"` → 500.
  - `primary_regions: []` → 500.
- Names:
  - a slug, at most 16 characters; 17 → 500 "Internal error";
  - not unique; a duplicate create succeeds and the databases are isolated;
  - `search` filters by name;
  - immutable (`PATCH` ignores it).
- An unknown id: `GET` → 404. `PATCH`, `DELETE` and token calls → 500.
- Tokens:
  - `PUT /v2/databases/{id}/auth/generate { authorization, expires_at? }` → `{ token, expires_at }`;
  - read-only tokens get 403 on writes;
  - `POST …/auth/revoke` invalidates **all** tokens; new tokens work afterwards.
- SQL: `POST https://<host>/v2/pipeline` (Hrana), `Authorization: Bearer <token>`.
  - A transient 421 "struggling to contact your database" occurs right after create or a region change.
  - `execute` with two statements → `SQL_MANY_STATEMENTS`; a `sequence` works.
  - A failing sequence stops, and closing the stream rolls it back.
  - Blobs come back base64 without padding.
