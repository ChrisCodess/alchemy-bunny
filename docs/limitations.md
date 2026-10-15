# Known limitations

What this release does not do, or has not proven yet. Contributions welcome.

## Not yet verified

- **`alchemy dev` with bindings.** The dev flow was verified before bindings existed. An `env` binding between a local dev server and a dev-stage Edge Script has not been exercised.
- **Alchemy profiles.** Credentials have been tested through `BUNNY_API_KEY` only.
- **Recovering from a token revoke-all.** The documented procedure has not been run end to end ([Token revocation](database.md#token-revocation)).

## Database tokens cannot be revoked individually

bunny.net revokes all of a database's tokens or none, and does not report revoked tokens. As a result:
- replacing or destroying a `DatabaseToken` leaves its JWT valid;
- the token `QueryDatabaseHttp` issues never expires;
- after a revoke-all, state keeps dead tokens until their state records are deleted and the stack is redeployed.

Details and the recovery steps are in [Token revocation](database.md#token-revocation).

## Storage

- **No streaming.** `get` buffers the whole file and `put` takes bytes or a string. Large files can exceed an Edge Script's 128 MB memory limit. R2's client streams in both directions; this one does not yet.
- **No `head`.** bunny.net's Edge Storage API rejects `HEAD`.
- **No deploy-time client.** There is no `*Local` implementation for Actions (R2 has one), for example to seed a zone at deploy time.
- **No write-only credential.** bunny.net has none: `WriteStorageZone` carries the full password, and only its client limits it to writes.

## Edge Script to Edge Script

- The callee must be an **Effect-native** Edge Script: only its runtime re-addresses forwarded requests. A bundled or `fetchHandler` callee sees its own URL.
- Middleware scripts have no URL and cannot be callees.
- The fetch key (`<Callee>FetchKey`, an `Alchemy.Random`) never rotates on its own. To rotate it, delete its state record (`bun alchemy state delete <stack>/<stage>/<Callee>FetchKey`) and deploy; the callee and every caller get the new key. ⚠️ Untested.

## Hosts

- Capabilities from other clouds that bind with `host.bind({ env })` only accept the host types they list (e.g. `Prisma.Connect`, Neon's), so they cannot bind into a `Bunny.EdgeScript`. Capabilities that yield Outputs (Stripe, Prisma buckets, the ones in this package) work.
- There is no local runtime for Effect-native Edge Scripts under `alchemy dev` (Cloudflare has workerd); they are deployed to the dev stage.

## Runtime

- `QueryDatabase` does not retry the database's transient 421 ("struggling to contact your database"), which can occur right after creation or a region change. It surfaces as `DatabaseQueryError`.
- Cold starts on Edge Scripting are slow for large bundles: about 3 s for a 2.5 MB framework server.

## Versions

- Exact peer versions: `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117`. Effect must be pinned with overrides, and Alchemy needs a [one-line patch](getting-started.md#installation) for Actions.
- bunny.net has no resource tags: no `alchemy nuke` listing, and explicitly named existing resources need `--adopt`.
