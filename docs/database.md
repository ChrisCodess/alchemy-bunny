# Bunny Database

```ts
const db = yield* Bunny.Database("Db", {
  primaryRegions: ["DE"],      // default
  replicaRegions: ["UK"],      // optional read replicas
  migrations: "./migrations",  // .sql files, applied in order on every deploy
});
const token = yield* Bunny.DatabaseToken("DbToken", { database: db }); // or authorization: "read-only"
```

Bunny Database is SQLite-compatible (libSQL) with primary regions and read replicas. Reach it from:

- Effect code in a script: [`QueryDatabase`](bindings.md#databases), which issues and binds its own token.
- Other code: the database `url` and a `DatabaseToken`'s `token`, as `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN` (the names `@bunny.net/database-client` reads by default), passed through `env`.

```ts
yield* Bunny.EdgeScript("Api", {
  main: "./src/api.ts",
  env: { BUNNY_DATABASE_URL: db.url, BUNNY_DATABASE_AUTH_TOKEN: token.token }, // the token is Redacted → a secret
});
```

## Names and regions

- Names are slugs (`^[a-z0-9]+(-[a-z0-9]+)*$`) of at most 16 characters; a generated name is `<logical id>-<8 chars>`. The name cannot change after creation.
- Names are **not unique** on bunny.net: two databases may share a name. A database is tracked by its id, and an explicit `name` that matches an existing database is reported as unowned (`--adopt` to take it over).
- `storageRegion` defaults to the storage region in the first primary region's group (`DE` → `eu-west-1`), as bunny.net's CLI does. Changing it replaces the database. `primaryRegions` and `replicaRegions` change in place; the first queries after a region change can get a transient 421.

## Migrations

`migrations` points at a directory of `.sql` files applied in filename order on every deploy. They use Alchemy's shared migration engine, the `__alchemy_migrations` table D1 and Neon use, so each file runs once; the resource records every applied file's hash (`migrationsHashes`).

Each file runs as **one transaction**: `BEGIN; …; COMMIT;` in a single Hrana `sequence`, followed by `ROLLBACK`. Multi-statement files are fine. A failing file applies nothing and fails the deploy, and the next deploy retries it. Migrations connect with a 15-minute token that is not stored.

## Tokens

`DatabaseToken` issues a JWT (`full-access` or `read-only`, optionally `expiresAt`) and keeps it in state as `Redacted`. Read-only tokens are rejected (403) on writes. Changing any prop issues a new token.

### Token revocation

bunny.net can revoke **all** of a database's tokens at once, never one. This has two consequences to plan around.

**Destroying or replacing a `DatabaseToken` does not revoke it.** The old JWT stays valid until it expires or all tokens are revoked. This includes the tokens `QueryDatabaseHttp` and the Better Auth layer issue when a stack changes or is destroyed. Set `expiresAt` on tokens you intend to rotate. (`QueryDatabaseHttp`'s own token has no expiry and takes no options.)

**After a revoke-all, Alchemy cannot tell.** Revoke with the dashboard, `bunny db tokens invalidate`, or the API (`POST https://api.bunny.net/database/v2/databases/{id}/auth/revoke`). The API does not report revoked tokens, so every `DatabaseToken` of that database keeps its dead value in state and deploys as a no-op, and the hosts keep the dead value bound. To reissue them:

1. Find the database's token resources: your `DatabaseToken`s, `<db>QueryDatabaseToken` for each database bound with `QueryDatabase`, and the one the Better Auth layer uses (also `<db>QueryDatabaseToken`).
2. Delete their state records. This does not touch bunny.net, and a token's delete calls nothing anyway:
   ```bash
   bun alchemy state delete <stack>/<stage>/<TokenLogicalId>
   ```
3. Deploy. New tokens are issued and re-bound into every host that uses them.

This procedure follows from how the provider and Alchemy's state work, but it has not been exercised end to end.

## SQL clients

- `QueryDatabase`: the Effect client in scripts ([Bindings](bindings.md#databases)).
- `alchemy-bunny/DatabaseD1`: `connectD1({ url, authToken })`, a Cloudflare-D1-compatible view over `@bunny.net/database-client` for libraries that accept a D1 binding (Better Auth's D1 dialect, `drizzle-orm/d1`). It imports no Alchemy or Effect code. It covers `prepare().bind()` with `all`, `first`, `run`, `raw`, plus `batch` (one transaction) and `exec`.
- Migrations use the internal SDK's `Sql` module (Hrana over `/v2/pipeline`), which retries 421, 429 and 5xx.

## Verified behaviour

Probed against the live API (2026-09-29):
- `AccessKey` auth works on the database API.
- A name that is not a slug is a 400, and a name over 16 characters is a 500.
- Duplicate names are allowed and the databases are isolated.
- `GET` answers 404 for an unknown id, while `PATCH`, `DELETE` and token calls answer 500 (the provider decides "gone" with `GET`).
- Revoke invalidates every token, and new tokens work afterwards.
- A multi-statement `execute` is rejected (`SQL_MANY_STATEMENTS`), which is why migrations use `sequence`.
- After a committed `sequence`, the trailing `ROLLBACK` errors with "no transaction is active"; the provider ignores it.
