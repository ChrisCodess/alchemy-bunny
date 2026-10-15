import { Core } from "alchemy-bunny-sdk";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { withPullZoneLock } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export type PullZoneOrigin =
  | {
      /** Serve files from a storage zone (pass the `StorageZone` resource). */
      readonly storageZone: { readonly storageZoneId: number };
    }
  | {
      /** Serve from an HTTP(S) origin. */
      readonly url: string;
      /** Host header sent to the origin. */
      readonly hostHeader?: string;
      /** Forward the viewer's Host header to the origin. @default false */
      readonly forwardHostHeader?: boolean;
    };

export interface PullZoneCache {
  /**
   * Edge cache TTL in seconds, overriding the origin's Cache-Control
   * (`CacheControlMaxAgeOverride`). Omit to leave the zone's setting alone.
   */
  readonly edgeTtlSeconds?: number;
  /**
   * Browser cache TTL in seconds sent to viewers
   * (`CacheControlPublicMaxAgeOverride`). Omit to leave the zone's setting
   * alone.
   */
  readonly browserTtlSeconds?: number;
}

export type PullZoneTier = "standard" | "volume";

export interface PullZoneProps {
  /**
   * Pull zone name. It is global across bunny.net and becomes the
   * `<name>.b-cdn.net` hostname. Changing it replaces the pull zone.
   *
   * If omitted, a unique name is generated from the stack, stage and
   * logical ID.
   */
  name?: string;
  /** Where the CDN fetches content from. */
  origin: PullZoneOrigin;
  /**
   * Network tier: `standard` (Premium network) or `volume`.
   * @default "standard"
   */
  tier?: PullZoneTier;
  /**
   * Enable SSL automatically for hostnames added to this zone.
   * @default true
   */
  enableAutoSSL?: boolean;
  /** Cache TTL overrides. */
  cache?: PullZoneCache;
  /**
   * Middleware Edge Script run in front of the origin (pass an `EdgeScript`
   * with `type: "middleware"`). Removing it detaches the script.
   */
  middleware?: { readonly scriptId: number };
}

export interface PullZoneAttributes {
  /** Numeric pull zone id. Stable across updates. */
  pullZoneId: number;
  /** Pull zone name. */
  name: string;
  /** System hostname, `<name>.b-cdn.net`. */
  hostname: string;
  /** `https://<hostname>`. */
  url: string;
  originType: "storageZone" | "url";
  storageZoneId: number | undefined;
  originUrl: string | undefined;
  tier: PullZoneTier;
  enableAutoSSL: boolean;
  edgeTtlSeconds: number | undefined;
  browserTtlSeconds: number | undefined;
  /** Attached middleware Edge Script, if any. */
  middlewareScriptId: number | undefined;
}

export type PullZone = Resource<
  "Bunny.PullZone",
  PullZoneProps,
  PullZoneAttributes,
  never,
  Providers
>;

/**
 * A bunny.net pull zone: the CDN in front of a storage zone or an HTTP
 * origin, served at `<name>.b-cdn.net` and any `PullZoneHostname`s.
 * @see https://bunny.net/docs/cdn
 *
 * @example
 * ```typescript
 * const zone = yield* Bunny.StorageZone("Files", {});
 * const cdn = yield* Bunny.PullZone("Cdn", {
 *   origin: { storageZone: zone },
 *   cache: { edgeTtlSeconds: 2592000, browserTtlSeconds: 0 },
 * });
 * ```
 *
 * @resource
 */
export const PullZone = Resource<PullZone>("Bunny.PullZone");

/** The pull zone name is taken, and not by a zone this account can see. */
export class PullZoneNameUnavailable extends Data.TaggedError(
  "PullZoneNameUnavailable",
)<{ readonly name: string }> {}

const ORIGIN_URL = 0;
const ORIGIN_STORAGE_ZONE = 2;

const systemHostname = (zone: Core.PullZoneModel): string =>
  zone.Hostnames?.find((hostname) => hostname.IsSystemHostname)?.Value ??
  `${zone.Name}.b-cdn.net`;

const toAttrs = (zone: Core.PullZoneModel): PullZoneAttributes => {
  const hostname = systemHostname(zone);
  const fromStorage = zone.OriginType === ORIGIN_STORAGE_ZONE;
  return {
    pullZoneId: zone.Id ?? 0,
    name: zone.Name ?? "",
    hostname,
    url: `https://${hostname}`,
    originType: fromStorage ? "storageZone" : "url",
    storageZoneId: fromStorage ? zone.StorageZoneId : undefined,
    originUrl: fromStorage ? undefined : zone.OriginUrl ?? undefined,
    tier: zone.Type === 1 ? "volume" : "standard",
    enableAutoSSL: zone.EnableAutoSSL ?? false,
    edgeTtlSeconds: zone.CacheControlMaxAgeOverride,
    browserTtlSeconds: zone.CacheControlPublicMaxAgeOverride,
    middlewareScriptId: zone.MiddlewareScriptId || undefined,
  };
};

const getZone = (id: number) =>
  Core.getPullZone({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/** GET /pullzone answers with a plain array or a page envelope. */
const findZoneByName = (name: string) =>
  Effect.gen(function* () {
    const result = yield* Core.listPullZones({ search: name });
    const zones = Array.isArray(result)
      ? result
      : [...((result as Core.PullZoneListPage).Items ?? [])];
    const match = zones.find(
      (zone) => zone.Name?.toLowerCase() === name.toLowerCase() && zone.Id !== undefined,
    );
    return match?.Id === undefined ? undefined : yield* getZone(match.Id);
  });

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 60 });

/** The settings a zone should have, as the API's field names. */
const desiredSettings = (news: PullZoneProps) => {
  const origin =
    "storageZone" in news.origin
      ? {
          OriginType: ORIGIN_STORAGE_ZONE,
          StorageZoneId: news.origin.storageZone.storageZoneId,
        }
      : {
          OriginType: ORIGIN_URL,
          OriginUrl: news.origin.url,
          ...(news.origin.hostHeader !== undefined
            ? { OriginHostHeader: news.origin.hostHeader }
            : {}),
          ...(news.origin.forwardHostHeader !== undefined
            ? { AddHostHeader: news.origin.forwardHostHeader }
            : {}),
        };
  return {
    ...origin,
    Type: news.tier === "volume" ? 1 : 0,
    EnableAutoSSL: news.enableAutoSSL ?? true,
    ...(news.cache?.edgeTtlSeconds !== undefined
      ? { CacheControlMaxAgeOverride: news.cache.edgeTtlSeconds }
      : {}),
    ...(news.cache?.browserTtlSeconds !== undefined
      ? { CacheControlPublicMaxAgeOverride: news.cache.browserTtlSeconds }
      : {}),
  };
};

/**
 * Middleware: set it when wanted; clear a live one with 0 (the API ignores
 * null and rejects -1); otherwise leave the field alone.
 */
const middlewareSetting = (
  news: PullZoneProps,
  zone: Core.PullZoneModel | undefined,
): { MiddlewareScriptId?: number } =>
  news.middleware !== undefined
    ? { MiddlewareScriptId: news.middleware.scriptId }
    : zone?.MiddlewareScriptId
      ? { MiddlewareScriptId: 0 }
      : {};

/** The desired settings that differ from the observed zone. */
const settingsDelta = (
  zone: Core.PullZoneModel,
  desired: Record<string, unknown>,
): Record<string, unknown> => {
  const observed = zone as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => observed[key] !== value),
  );
};

export const PullZoneProvider = () =>
  Provider.succeed(PullZone, {
    stables: ["pullZoneId", "name", "hostname", "url"],
    // Non-listable: bunny.net has no tags or labels, so an account's zones
    // cannot be told apart from zones Alchemy does not manage.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.name !== undefined && news.name !== output.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.pullZoneId !== undefined) {
        const zone = yield* getZone(output.pullZoneId);
        return zone === undefined ? undefined : toAttrs(zone);
      }
      const explicitName = olds?.name;
      const zone = yield* findZoneByName(explicitName ?? (yield* generatedName(id)));
      if (zone === undefined) return undefined;
      return explicitName === undefined ? toAttrs(zone) : Unowned(toAttrs(zone));
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const desired = desiredSettings(news);

      // 1. Observe
      let zone =
        output?.pullZoneId !== undefined
          ? yield* getZone(output.pullZoneId)
          : undefined;
      if (zone === undefined) zone = yield* findZoneByName(name);

      // 2. Ensure
      if (zone === undefined) {
        const created = yield* Core.createPullZone({
          Name: name,
          ...desired,
          ...middlewareSetting(news, undefined),
        }).pipe(
          Effect.catchTag("NameTaken", () =>
            findZoneByName(name).pipe(
              Effect.flatMap((existing) =>
                existing === undefined
                  ? Effect.fail(new PullZoneNameUnavailable({ name }))
                  : Effect.succeed(existing),
              ),
            ),
          ),
        );
        zone =
          (created.Id === undefined ? undefined : yield* getZone(created.Id)) ??
          created;
        yield* session.note(`Created pull zone ${name}`);
      }

      // 3. Sync — send only the settings that differ from the live zone
      const pullZoneId = zone.Id ?? 0;
      const delta = settingsDelta(zone, { ...desired, ...middlewareSetting(news, zone) });
      if (Object.keys(delta).length > 0) {
        zone = yield* withPullZoneLock(pullZoneId)(
          Core.updatePullZone({ id: pullZoneId, ...delta }),
        );
      }

      return toAttrs(zone);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* withPullZoneLock(output.pullZoneId)(
        Core.deletePullZone({ id: output.pullZoneId }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
