# Changelog

## 0.1.0 — unreleased

First release of `alchemy-bunny` and `alchemy-bunny-sdk`, for `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117`.

### alchemy-bunny

- **Resources:** `StorageZone`, `PullZone`, `PullZoneHostname`, `StorageDeployment`, `PurgeCache`, `EdgeRule`, `EdgeScript`, `Database` (with SQL migrations), `DatabaseToken`.
- **`EdgeScript` as an Alchemy Platform host:**
  - a bundled file, or an Effect-native class like `Cloudflare.Worker`;
  - `env` routed by shape (`Redacted` → secret; an Edge Script → a service-binding-like binding);
  - a Binding Contract (`{ env }`);
  - cookies enabled on the linked pull zone.
- **Bindings:**
  - `ReadStorageZone`, `WriteStorageZone`, `ReadWriteStorageZone`;
  - `QueryDatabase` (with `QueryDatabaseLocal` for Actions);
  - `FetchEdgeScript`.
  
  They work in Edge Scripts and other Alchemy hosts. `edgeScriptFetcher` covers non-Effect callers.
- **Websites:** `Website.StaticSite`, and `Website.TanStackStart` (on Alchemy's `Website.Server`).
- **Better Auth:** `alchemy-bunny/BetterAuth`'s `BunnyDatabase` layer for `@alchemy.run/better-auth`.
- `alchemy-bunny/DatabaseD1`: a Cloudflare-D1-compatible view of a Bunny Database.

### alchemy-bunny-sdk (internal dependency)

- `Core`, `Compute` and `Database` clients generated from bunny.net's OpenAPI documents, with patches for spec defects.
- Hand-written `Storage` (Edge Storage) and `Sql` (Hrana) clients, and `checksumOf`.
