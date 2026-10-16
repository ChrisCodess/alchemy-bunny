# Known limitations

What this release does not do, or has not proven yet. Contributions welcome.

## Not yet verified

- The dev flow was verified before bindings existed. An `env` binding between a local dev server and a dev-stage Edge Script has not been exercised.
- Credentials have been tested through `BUNNY_API_KEY` only, never through an Alchemy profile.
- The documented procedure for recovering from a token revoke-all has not been run end to end ([Token revocation](database.md#token-revocation)).

## Bunny Database is in public preview

bunny.net limits an account to 50 databases and a database to 1 GB during the preview, and says features and APIs may change. The SDK is generated from the current v2 API.

## Database tokens cannot be revoked individually

bunny.net revokes all of a database's tokens or none, and does not report revoked tokens. As a result:
- replacing or destroying a `DatabaseToken` leaves its JWT valid;
- the token `QueryDatabaseHttp` issues never expires;
- after a revoke-all, state keeps dead tokens until their state records are deleted and the stack is redeployed.

Details and the recovery steps are in [Token revocation](database.md#token-revocation).

## Storage

- `get` buffers the whole file and `put` takes bytes or a string. Large files can exceed an Edge Script's 128 MB memory limit. R2's client streams in both directions; this one does not yet.
- There is no `head`: bunny.net's Edge Storage API rejects `HEAD`.
- There is no `*Local` implementation for Actions (R2 has one), for example to seed a zone at deploy time.
- bunny.net has no write-only credential: `WriteStorageZone` carries the full password, and only its client limits it to writes.

## Edge Script to Edge Script

- The callee must be an **Effect-native** Edge Script: only its runtime re-addresses forwarded requests. A bundled or `fetchHandler` callee sees its own URL.
- Middleware scripts have no URL and cannot be callees.
- The fetch key (`<Callee>FetchKey`, an `Alchemy.Random`) never rotates on its own. To rotate it, delete its state record (`bun alchemy state delete <stack>/<stage>/<Callee>FetchKey`) and deploy; the callee and every caller get the new key. This procedure is untested.

## Hosts

- Capabilities from other clouds that bind with `host.bind({ env })` only accept the host types they list (e.g. `Prisma.Connect`, Neon's), so they cannot bind into a `Bunny.EdgeScript`. Capabilities that yield Outputs (Stripe, Prisma buckets, the ones in this package) work.
- There is no local runtime for Effect-native Edge Scripts under `alchemy dev` (Cloudflare has workerd); they are deployed to the dev stage.

## Runtime

- `QueryDatabase` does not retry the database's transient 421 ("struggling to contact your database"), which can occur right after creation or a region change. It surfaces as `DatabaseQueryError`.
- A migration transaction is not re-sent after a lost response or a gateway error, since the server may have committed it. The deploy fails, and the next one retries the migration.
- Cold starts on Edge Scripting are slow for large bundles: about 3 s for a 2.5 MB framework server.

## Versions

- `alchemy` is an exact peer version, `2.0.0-beta.83`. `effect` is `^4.0.0`, tested with `4.0.5`.
- bunny.net has no resource tags: no `alchemy nuke` listing, and explicitly named existing resources need `--adopt`.
