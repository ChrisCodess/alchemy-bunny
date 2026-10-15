import { Core } from "alchemy-bunny-sdk";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { withPullZoneLock } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export interface PullZoneHostnameProps {
  /** The pull zone to serve on this hostname (pass the `PullZone` resource). */
  pullZone: { readonly pullZoneId: number };
  /**
   * Custom hostname, e.g. `www.example.com`. Its DNS must CNAME to the pull
   * zone's `hostname` before a certificate can be issued. A hostname can
   * belong to one pull zone only; changing it replaces this resource.
   */
  hostname: string;
  /**
   * Certificate: `free` requests a Let's Encrypt certificate; `none` leaves
   * certificates alone.
   * @default "free"
   */
  certificate?: "free" | "none";
  /**
   * Redirect HTTP to HTTPS. Applied once a certificate exists.
   * @default true
   */
  forceSSL?: boolean;
}

export interface PullZoneHostnameAttributes {
  pullZoneId: number;
  /** Lowercased hostname. */
  hostname: string;
  /** Numeric hostname id, when bunny.net reports one. */
  hostnameId: number | undefined;
  hasCertificate: boolean;
  forceSSL: boolean;
  /** `https://<hostname>`. */
  url: string;
}

export type PullZoneHostname = Resource<
  "Bunny.PullZoneHostname",
  PullZoneHostnameProps,
  PullZoneHostnameAttributes,
  never,
  Providers
>;

/**
 * A custom hostname on a bunny.net pull zone, with an optional free
 * certificate.
 *
 * The certificate can only be issued after the hostname's DNS points at the
 * pull zone. If it is not issued yet, the deploy still succeeds with
 * `hasCertificate: false`, and the next deploy requests it again.
 * @see https://bunny.net/docs/cdn/custom-hostname
 *
 * @example
 * ```typescript
 * yield* Cloudflare.DNS.Record("WwwCname", {
 *   zoneId,
 *   name: "www.example.com",
 *   type: "CNAME",
 *   content: cdn.hostname,
 *   proxied: false,
 * });
 * const www = yield* Bunny.PullZoneHostname("Www", {
 *   pullZone: cdn,
 *   hostname: "www.example.com",
 * });
 * ```
 *
 * @resource
 */
export const PullZoneHostname = Resource<PullZoneHostname>(
  "Bunny.PullZoneHostname",
);

const findHostname = (zone: Core.PullZoneModel, hostname: string) =>
  zone.Hostnames?.find((entry) => entry.Value?.toLowerCase() === hostname);

const toAttrs = (
  pullZoneId: number,
  hostname: string,
  entry: Core.HostnameModel | undefined,
): PullZoneHostnameAttributes => ({
  pullZoneId,
  hostname,
  hostnameId: entry?.Id,
  hasCertificate: entry?.HasCertificate ?? false,
  forceSSL: entry?.ForceSSL ?? false,
  url: `https://${hostname}`,
});

const getZone = (id: number) =>
  Core.getPullZone({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/**
 * Request a free certificate, then re-read until it shows up. The request
 * can answer 200 without a certificate landing (official Bunny CLI), and it
 * fails outright while DNS does not point at the zone yet.
 */
const ensureCertificate = (pullZoneId: number, hostname: string) =>
  Effect.gen(function* () {
    const requested = yield* Core.loadFreeCertificate({ hostname }).pipe(
      Effect.as(true),
      Effect.catchTags({
        BadRequest: () => Effect.succeed(false),
        NotFound: () => Effect.succeed(false),
      }),
    );
    if (!requested) return false;
    return yield* getZone(pullZoneId).pipe(
      Effect.map((zone) =>
        zone === undefined ? false : (findHostname(zone, hostname)?.HasCertificate ?? false),
      ),
      Effect.repeat({
        until: (hasCertificate) => hasCertificate,
        times: 6,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const PullZoneHostnameProvider = () =>
  Provider.succeed(PullZoneHostname, {
    stables: ["pullZoneId", "hostname", "url"],
    // Non-listable: hostnames live inside pull zones that cannot be
    // attributed to Alchemy (no tags on bunny.net).
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (
        news.hostname.toLowerCase() !== output.hostname ||
        news.pullZone.pullZoneId !== output.pullZoneId
      ) {
        // A hostname maps to one pull zone at a time: remove it first.
        return { action: "replace", deleteFirst: true } as const;
      }
      const wantsCertificate = (news.certificate ?? "free") === "free";
      if (
        (wantsCertificate && !output.hasCertificate) ||
        (output.hasCertificate && (news.forceSSL ?? true) !== output.forceSSL)
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const pullZoneId = output?.pullZoneId ?? olds?.pullZone.pullZoneId;
      const hostname = (output?.hostname ?? olds?.hostname)?.toLowerCase();
      if (pullZoneId === undefined || hostname === undefined) return undefined;
      const zone = yield* getZone(pullZoneId);
      const entry = zone === undefined ? undefined : findHostname(zone, hostname);
      return entry === undefined ? undefined : toAttrs(pullZoneId, hostname, entry);
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const pullZoneId = news.pullZone.pullZoneId;
      const hostname = news.hostname.toLowerCase();

      return yield* withPullZoneLock(pullZoneId)(
        Effect.gen(function* () {
          // 1. Observe
          let zone = yield* Core.getPullZone({ id: pullZoneId });
          let entry = findHostname(zone, hostname);

          // 2. Ensure — adding an existing hostname errors; confirm by re-reading
          if (entry === undefined) {
            yield* Core.addPullZoneHostname({ id: pullZoneId, Hostname: hostname }).pipe(
              Effect.catchTag("BadRequest", (error) =>
                Core.getPullZone({ id: pullZoneId }).pipe(
                  Effect.flatMap((current) =>
                    findHostname(current, hostname) === undefined
                      ? Effect.fail(error)
                      : Effect.void,
                  ),
                ),
              ),
            );
            zone = yield* Core.getPullZone({ id: pullZoneId });
            entry = findHostname(zone, hostname);
          }

          // 3. Sync — certificate, then Force SSL (only with a certificate)
          if ((news.certificate ?? "free") === "free" && !(entry?.HasCertificate ?? false)) {
            const issued = yield* ensureCertificate(pullZoneId, hostname);
            if (!issued) {
              yield* session.note(
                `No certificate for ${hostname} yet. Point its DNS at the pull zone; the next deploy retries.`,
              );
            }
            zone = yield* Core.getPullZone({ id: pullZoneId });
            entry = findHostname(zone, hostname);
          }
          const forceSSL = news.forceSSL ?? true;
          if ((entry?.HasCertificate ?? false) && (entry?.ForceSSL ?? false) !== forceSSL) {
            yield* Core.setPullZoneForceSSL({
              id: pullZoneId,
              Hostname: hostname,
              ForceSSL: forceSSL,
            });
            zone = yield* Core.getPullZone({ id: pullZoneId });
            entry = findHostname(zone, hostname);
          }

          return toAttrs(pullZoneId, hostname, entry);
        }),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* withPullZoneLock(output.pullZoneId)(
        Effect.gen(function* () {
          const zone = yield* getZone(output.pullZoneId);
          if (zone === undefined || findHostname(zone, output.hostname) === undefined) {
            return;
          }
          yield* Core.removePullZoneHostname({
            id: output.pullZoneId,
            Hostname: output.hostname,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      );
    }),
  });
