# Resources

Every resource is `yield*`ed inside a stack and exported flat from `alchemy-bunny` (`Bunny.StorageZone`, `Bunny.PullZone`, …). Props take Alchemy Outputs anywhere (`zone.storageZoneId`, `db.url`). Names are generated from the stack, stage and logical ID unless you pass `name`.

| Resource | Key props | Replaced when | Notes |
| --- | --- | --- | --- |
| `StorageZone` | `region` (default `DE`), `replicationRegions`, `tier`, `s3`, `rewrite404To200`, `custom404FilePath` | name, region, tier, `s3`, a replication region is removed | Attributes include `storageHostname`, `password` and `readOnlyPassword` (both `Redacted`). Deleted with `deleteLinkedPullZones=false` (the API's default would delete the CDN too). |
| `PullZone` | `origin` (`{ storageZone }` or `{ url, hostHeader?, forwardHostHeader? }`), `cache` (`edgeTtlSeconds`, `browserTtlSeconds`), `middleware`, `tier`, `enableAutoSSL` | name | Writes to one zone are serialised, as bunny.net's Terraform provider does. |
| `PullZoneHostname` | `pullZone`, `hostname`, `certificate` (`"free"` default), `forceSSL` | hostname, pull zone (deleted first) | Requests a free certificate. If DNS does not point at the zone yet, the deploy succeeds with `hasCertificate: false` and the next deploy retries; force-SSL is applied once a certificate exists. |
| `StorageDeployment` | `storageZone`, `sourcePath`, `prefix`, `purge`, `fileOptions` | never | Uploads only files whose SHA-256 differs (with a `Checksum` header, so corrupt uploads are rejected), HTML last. `purge` deletes files that are no longer in `sourcePath`. Plans as a no-op when the directory is unchanged. `version` changes when any file does. |
| `PurgeCache` | `pullZone`, `version`, `cacheTag` | never | Purges when `version` changes, e.g. `StorageDeployment.version`. |
| `EdgeRule` | `pullZone`, `action`, `when` (`url` / `extension` patterns, at most 5 each), `enabled`, `orderIndex` | pull zone | Typed actions: `ForceDownload`, `OverrideBrowserCacheTime`, `OverrideCacheTime`, `SetResponseHeader`, `SetRequestHeader`, `BlockRequest`, `OriginStorage`, and `Raw` for anything else. Updated in place by its `Guid`. |
| `EdgeScript` | `main`, `type` (`standalone` / `middleware`), `env`, `fetchHandler`, `cookies`, `bundle` | type | The bunny.net compute host. See [Edge Scripts](edge-scripts.md). |
| `Database` | `primaryRegions` (default `["DE"]`), `replicaRegions`, `storageRegion`, `migrations` | name, `storageRegion` | Bunny Database (libSQL). See [Bunny Database](database.md). |
| `DatabaseToken` | `database`, `authorization` (`full-access` / `read-only`), `expiresAt` | any prop | A JWT kept as `Redacted`. It cannot be revoked on its own; read [Token revocation](database.md#token-revocation). |

Composites (under `Bunny.Website`) build on these: [`Website.StaticSite` and `Website.TanStackStart`](websites.md).

## Storage zone names

Storage zone names are global across bunny.net. After a zone is deleted its name stays blocked ("The storage zone is currently being deleted.") for an undocumented time, still blocked 40 minutes later in testing. So the provider refuses to *replace* a storage zone that has an explicit `name` (the plan fails and says why); rename it or let Alchemy generate names, which is the default. Pull zone names are free again immediately.

## Adoption and ownership

bunny.net has no tags or labels, so the provider cannot mark resources as Alchemy's:

- An existing zone or database with an explicit `name` is reported as unowned; deploy with `--adopt` to take it over.
- Resources are not listed for `alchemy nuke`.
- Database names are not unique on bunny.net, so databases are tracked by id; if two databases share an explicit name, the deploy stops and says so.

## Errors

Operations fail with typed errors: `NameTaken`, `NameBeingDeleted`, `NotFound`, `StorageZoneMissing`, `DatabaseMissing`, `EdgeScriptEnvConflict`, `EdgeScriptEnvInvalid`, and the storage bindings' `Storage*` errors. The API clients retry throttling and 5xx responses; a call that creates a database, a script, an edge rule or a token is retried only when throttled, since a re-send after a lost response would make a duplicate. The SQL client the provider uses for migrations retries the database's transient 421 ("struggling to contact your database", right after creation or a region change). The runtime `QueryDatabase` client does not retry: a 421 there surfaces as a `DatabaseQueryError`.
