import { Core } from "alchemy-bunny-sdk";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  normalizeRegion,
  toRedacted,
  type StorageRegion,
} from "./internal.ts";
import type { Providers } from "./Providers.ts";

export type StorageZoneTierName = "standard" | "edge";

export interface StorageZoneProps {
  /**
   * Storage zone name: 4–64 characters, lowercase letters, digits and
   * dashes. Names are global across all bunny.net customers. Changing it
   * replaces the zone.
   *
   * If omitted, a unique name is generated from the stack, stage and
   * logical ID.
   */
  name?: string;
  /**
   * Primary storage region. Changing it replaces the zone.
   * @default "DE"
   */
  region?: StorageRegion;
  /**
   * Regions to replicate files to. Regions can be added in place; bunny.net
   * cannot remove a replication region, so removing one replaces the zone.
   */
  replicationRegions?: StorageRegion[];
  /**
   * Storage tier: `standard` (HDD) or `edge` (SSD). Changing it replaces
   * the zone.
   * @default "standard"
   */
  tier?: StorageZoneTierName;
  /**
   * Enable the S3-compatible API (public preview). It can only be set when
   * the zone is created; changing it replaces the zone.
   * @default false
   */
  s3?: boolean;
  /**
   * Answer 404s for paths without a file extension with 200. With
   * `custom404FilePath: "/index.html"` this is the SPA fallback.
   * @default false
   */
  rewrite404To200?: boolean;
  /** File served instead of a plain 404 (e.g. `/404.html`). */
  custom404FilePath?: string;
}

export interface StorageZoneAttributes {
  /** Numeric storage zone id. Stable across updates. */
  storageZoneId: number;
  /** Storage zone name. */
  name: string;
  /** Primary region code. */
  region: string;
  /** Replication region codes. */
  replicationRegions: string[];
  tier: StorageZoneTierName;
  /** Whether the S3-compatible API is enabled. */
  s3: boolean;
  /** Edge Storage API host for this zone, e.g. `storage.bunnycdn.com`. */
  storageHostname: string;
  /** S3 API host when `s3` is enabled. */
  s3Hostname: string | undefined;
  rewrite404To200: boolean;
  custom404FilePath: string | undefined;
  /** Read/write password for the Edge Storage API. */
  password: Redacted.Redacted<string>;
  /** Read-only password for the Edge Storage API. */
  readOnlyPassword: Redacted.Redacted<string>;
}

export type StorageZone = Resource<
  "Bunny.StorageZone",
  StorageZoneProps,
  StorageZoneAttributes,
  never,
  Providers
>;

/**
 * A bunny.net storage zone: object storage for site files, fronted by a
 * `PullZone`.
 * @see https://bunny.net/docs/storage
 *
 * @example
 * ```typescript
 * const zone = yield* Bunny.StorageZone("Files", {
 *   region: "DE",
 *   replicationRegions: ["NY", "SG"],
 * });
 * ```
 *
 * @resource
 */
export const StorageZone = Resource<StorageZone>("Bunny.StorageZone");

/**
 * The zone name cannot be used: another account holds it, or a zone with
 * this name was deleted recently (bunny.net keeps the name blocked for an
 * undocumented time after deletion).
 */
export class StorageZoneNameUnavailable extends Data.TaggedError(
  "StorageZoneNameUnavailable",
)<{ readonly name: string; readonly message: string }> {}

/**
 * The change needs a new zone, but the zone has an explicit `name`, and
 * bunny.net blocks a deleted zone's name, so the replacement cannot reuse it.
 */
export class StorageZoneReplaceNeedsNewName extends Data.TaggedError(
  "StorageZoneReplaceNeedsNewName",
)<{ readonly name: string; readonly message: string }> {}

const DEFAULT_REGION = "DE";

const tierName = (tier: Core.StorageZoneTier | undefined): StorageZoneTierName =>
  tier === 1 ? "edge" : "standard";

const toAttrs = (zone: Core.StorageZoneModel): StorageZoneAttributes => ({
  storageZoneId: zone.Id ?? 0,
  name: zone.Name ?? "",
  region: normalizeRegion(zone.Region ?? DEFAULT_REGION),
  replicationRegions: [...(zone.ReplicationRegions ?? [])].map(normalizeRegion),
  tier: tierName(zone.ZoneTier),
  s3: zone.StorageZoneType === 1,
  storageHostname: zone.StorageHostname ?? "storage.bunnycdn.com",
  s3Hostname: zone.S3Hostname ?? undefined,
  rewrite404To200: zone.Rewrite404To200 ?? false,
  custom404FilePath: zone.Custom404FilePath || undefined,
  password: toRedacted(zone.Password),
  readOnlyPassword: toRedacted(zone.ReadOnlyPassword),
});

const getZone = (id: number) =>
  Core.getStorageZone({ id }).pipe(
    Effect.map((zone) => (zone.Deleted === true ? undefined : zone)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live zone by exact name, then re-fetch it (list entries may omit
 * passwords). The API ignores `search` on this endpoint and returns every
 * zone (observed on the live API), so the match is done here.
 */
const findZoneByName = (name: string) =>
  Effect.gen(function* () {
    const zones = yield* Core.listStorageZones({ search: name });
    const match = zones.find(
      (zone) =>
        zone.Name?.toLowerCase() === name.toLowerCase() &&
        zone.Deleted !== true &&
        zone.Id !== undefined,
    );
    return match?.Id === undefined ? undefined : yield* getZone(match.Id);
  });

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 64 });

const desiredOf = (news: StorageZoneProps) => ({
  region: normalizeRegion(news.region ?? DEFAULT_REGION),
  replicationRegions: (news.replicationRegions ?? []).map(normalizeRegion),
  tier: news.tier ?? "standard",
  s3: news.s3 ?? false,
  rewrite404To200: news.rewrite404To200 ?? false,
  custom404FilePath: news.custom404FilePath || undefined,
});

export const StorageZoneProvider = () =>
  Provider.succeed(StorageZone, {
    stables: [
      "storageZoneId",
      "name",
      "region",
      "tier",
      "s3",
      "storageHostname",
      "s3Hostname",
    ],
    // Non-listable: bunny.net has no tags or labels, so an account's zones
    // cannot be told apart from zones Alchemy does not manage.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      const desired = desiredOf(news);
      const settingNeedsNewZone =
        desired.region !== output.region ||
        desired.tier !== output.tier ||
        desired.s3 !== output.s3 ||
        output.replicationRegions.some(
          (region) => !desired.replicationRegions.includes(region),
        );
      if (settingNeedsNewZone && news.name !== undefined && news.name === output.name) {
        return yield* new StorageZoneReplaceNeedsNewName({
          name: news.name,
          message:
            `Storage zone "${news.name}": changing region, tier or s3, or removing a replication ` +
            `region needs a new zone, and bunny.net keeps a deleted zone's name blocked. ` +
            `Give the zone a new name, or remove \`name\` to let Alchemy generate one.`,
        });
      }
      if (settingNeedsNewZone || (news.name !== undefined && news.name !== output.name)) {
        return { action: "replace" } as const;
      }
      if (
        desired.replicationRegions.some(
          (region) => !output.replicationRegions.includes(region),
        ) ||
        desired.rewrite404To200 !== output.rewrite404To200 ||
        desired.custom404FilePath !== output.custom404FilePath
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.storageZoneId !== undefined) {
        const zone = yield* getZone(output.storageZoneId);
        return zone === undefined ? undefined : toAttrs(zone);
      }
      const explicitName = olds?.name;
      const zone = yield* findZoneByName(explicitName ?? (yield* generatedName(id)));
      if (zone === undefined) return undefined;
      // A generated name embeds this resource's instance id, so a match is a
      // zone this resource created earlier. An explicit name proves nothing.
      return explicitName === undefined ? toAttrs(zone) : Unowned(toAttrs(zone));
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const desired = desiredOf(news);

      // 1. Observe
      let zone =
        output?.storageZoneId !== undefined
          ? yield* getZone(output.storageZoneId)
          : undefined;
      if (zone === undefined) zone = yield* findZoneByName(name);

      // 2. Ensure
      if (zone === undefined) {
        const created = yield* Core.createStorageZone({
          Name: name,
          Region: desired.region,
          ReplicationRegions: desired.replicationRegions,
          ZoneTier: desired.tier === "edge" ? 1 : 0,
          StorageZoneType: desired.s3 ? 1 : 0,
        }).pipe(
          Effect.catchTags({
            NameTaken: () =>
              findZoneByName(name).pipe(
                Effect.flatMap((existing) =>
                  existing === undefined
                    ? Effect.fail(
                        new StorageZoneNameUnavailable({
                          name,
                          message: `Storage zone name "${name}" is taken by another bunny.net account.`,
                        }),
                      )
                    : Effect.succeed(existing),
                ),
              ),
            NameBeingDeleted: () =>
              Effect.fail(
                new StorageZoneNameUnavailable({
                  name,
                  message:
                    `Storage zone name "${name}" belongs to a zone that was deleted recently; ` +
                    `bunny.net keeps it blocked for a while. Use another name, or remove \`name\`.`,
                }),
              ),
          }),
        );
        zone =
          (created.Id === undefined ? undefined : yield* getZone(created.Id)) ??
          created;
        yield* session.note(`Created storage zone ${name}`);
      }

      // 3. Sync — replication, 404 handling (one update carries all three)
      const observed = toAttrs(zone);
      const replication = [
        ...new Set([...observed.replicationRegions, ...desired.replicationRegions]),
      ];
      if (
        replication.length !== observed.replicationRegions.length ||
        observed.rewrite404To200 !== desired.rewrite404To200 ||
        observed.custom404FilePath !== desired.custom404FilePath
      ) {
        yield* Core.updateStorageZone({
          id: observed.storageZoneId,
          ReplicationZones: replication,
          Rewrite404To200: desired.rewrite404To200,
          // The API ignores null; only an empty path clears it.
          Custom404FilePath: desired.custom404FilePath ?? "",
        });
        zone = (yield* getZone(observed.storageZoneId)) ?? zone;
      }

      return toAttrs(zone);
    }),
    delete: Effect.fn(function* ({ output }) {
      // The API's default also deletes every linked pull zone; never do that.
      yield* Core.deleteStorageZone({
        id: output.storageZoneId,
        deleteLinkedPullZones: false,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
