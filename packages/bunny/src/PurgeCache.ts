import { Core } from "alchemy-bunny-sdk";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { withPullZoneLock } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export interface PurgeCacheProps {
  /** The pull zone to purge (pass the `PullZone` resource). */
  pullZone: { readonly pullZoneId: number };
  /**
   * Purge token. The cache is purged when the resource is created and every
   * time this value changes, e.g. `StorageDeployment.version`.
   */
  version: string;
  /** Purge only responses tagged with this `CDN-Tag`. Omit to purge all. */
  cacheTag?: string;
}

export interface PurgeCacheAttributes {
  pullZoneId: number;
  /** The version the cache was last purged for. */
  version: string;
  cacheTag: string | undefined;
}

export type PurgeCache = Resource<
  "Bunny.PurgeCache",
  PurgeCacheProps,
  PurgeCacheAttributes,
  never,
  Providers
>;

/**
 * Purge a pull zone's cache whenever `version` changes. Deleting it does
 * nothing.
 * @see https://bunny.net/docs/cdn/purge-cache
 *
 * @example
 * ```typescript
 * const files = yield* Bunny.StorageDeployment("Files", { storageZone, sourcePath: "dist" });
 * yield* Bunny.PurgeCache("Purge", { pullZone: cdn, version: files.version });
 * ```
 *
 * @resource
 */
export const PurgeCache = Resource<PurgeCache>("Bunny.PurgeCache");

export const PurgeCacheProvider = () =>
  Provider.succeed(PurgeCache, {
    stables: ["pullZoneId"],
    // Non-listable: a purge is an action, not a standing cloud resource.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (
        news.version !== output.version ||
        news.pullZone.pullZoneId !== output.pullZoneId ||
        news.cacheTag !== output.cacheTag
      ) {
        return { action: "update" } as const;
      }
      return { action: "noop" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      const pullZoneId = news.pullZone.pullZoneId;
      if (
        output !== undefined &&
        output.version === news.version &&
        output.pullZoneId === pullZoneId &&
        output.cacheTag === news.cacheTag
      ) {
        return output;
      }
      yield* withPullZoneLock(pullZoneId)(
        Core.purgePullZoneCache({
          id: pullZoneId,
          body: news.cacheTag !== undefined ? { CacheTag: news.cacheTag } : {},
        }),
      );
      yield* session.note(
        news.cacheTag !== undefined
          ? `Purged tag ${news.cacheTag} on pull zone ${pullZoneId}`
          : `Purged pull zone ${pullZoneId}`,
      );
      return { pullZoneId, version: news.version, cacheTag: news.cacheTag };
    }),
    delete: () => Effect.void,
  });
