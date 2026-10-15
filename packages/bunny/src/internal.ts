import { Core, type Storage } from "alchemy-bunny-sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

/**
 * Storage zone regions. The API documents DE, NY, LA and SG as primary
 * regions; the storage hostnames also cover UK, SE, BR, JH and SYD. Unknown
 * codes are passed through for the API to validate.
 */
export type StorageRegion =
  | "DE"
  | "NY"
  | "LA"
  | "SG"
  | "UK"
  | "SE"
  | "BR"
  | "JH"
  | "SYD"
  | (string & {});

export const normalizeRegion = (region: string): string => region.toUpperCase();

/** Bunny returns secrets as `string | Redacted | null`; normalise to Redacted. */
export const toRedacted = (
  value: string | Redacted.Redacted<string> | null | undefined,
): Redacted.Redacted<string> =>
  value == null
    ? Redacted.make("")
    : typeof value === "string"
      ? Redacted.make(value)
      : value;

const pullZoneLocks = new Map<number, Semaphore.Semaphore>();

/**
 * Serialise writes to one pull zone. Bunny's Terraform provider does the
 * same (a per-zone mutex around hostname, edge rule and settings changes):
 * concurrent writes to one zone are not safe.
 */
export const withPullZoneLock =
  (pullZoneId: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let lock = pullZoneLocks.get(pullZoneId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        pullZoneLocks.set(pullZoneId, lock);
      }
      return Semaphore.withPermit(lock, effect);
    });

/** The storage zone a StorageDeployment targets no longer exists. */
export class StorageZoneMissing extends Data.TaggedError("StorageZoneMissing")<{
  readonly storageZoneId: number;
}> {}

/**
 * Resolve the Edge Storage endpoint and password for a storage zone with the
 * account API key. The password is fetched when needed and never persisted
 * by the resources that use it.
 *
 * `BUNNY_STORAGE_ENDPOINT` overrides the storage origin (default
 * `https://{StorageHostname}`), e.g. for a local test server.
 */
export const resolveStorageAccess = (storageZoneId: number) =>
  Effect.gen(function* () {
    const zone = yield* Core.getStorageZone({ id: storageZoneId }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
    if (zone === undefined || zone.Deleted === true || !zone.Name) {
      return yield* new StorageZoneMissing({ storageZoneId });
    }
    const endpoint = process.env.BUNNY_STORAGE_ENDPOINT;
    const access: Storage.StorageZoneAccess = {
      hostname: zone.StorageHostname ?? "storage.bunnycdn.com",
      zoneName: zone.Name,
      password: toRedacted(zone.Password),
      ...(endpoint ? { endpoint } : {}),
    };
    return access;
  });
