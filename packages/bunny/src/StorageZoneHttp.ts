/**
 * Shared scaffolding for the storage zone capabilities' HTTP
 * implementations (`ReadStorageZoneHttp`, `WriteStorageZoneHttp`,
 * `ReadWriteStorageZoneHttp`). NOT exported from `index.ts`.
 *
 * bunny.net has no native binding, so — like Alchemy's Stripe and Prisma
 * bucket capabilities — the zone's Edge Storage host, name and password
 * travel as Outputs yielded during the host's init: `RuntimeContext.set`
 * binds them into whichever host runs the capability (a `Bunny.EdgeScript`
 * or a Lambda; `Redacted` values as secrets), and the
 * returned accessors read them back at runtime. No `host.bind`.
 *
 * `Read` binds the zone's read-only password: bunny.net serves GET and
 * listings with it and rejects PUT and DELETE (401; probed 2026-09-29).
 * There is no write-only password, so `Write` binds the full one and its
 * client exposes no reads (the role caveat of Alchemy's Prisma buckets).
 */
import type * as Storage from "alchemy-bunny-sdk/storage";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { StorageZone } from "./StorageZone.ts";

/** Access level a storage zone binding grants. */
export type StorageZoneAccessLevel = "Read" | "Write" | "ReadWrite";

/** Runs one Edge Storage operation with the bound zone's access. */
export interface StorageZoneHttp {
  readonly run: <A>(
    operation: (access: Storage.StorageZoneAccess) => Effect.Effect<A, Storage.StorageError, HttpClient.HttpClient>,
  ) => Effect.Effect<A, Storage.StorageError, RuntimeContext>;
}

/** Build a {@link StorageZoneHttp} from a (deferred) zone access and an `HttpClient`. */
export const makeStorageZoneHttpClient = (
  access: Effect.Effect<Storage.StorageZoneAccess, never, RuntimeContext>,
  http: HttpClient.HttpClient,
): StorageZoneHttp => ({
  run: (operation) =>
    Effect.flatMap(access, (resolved) =>
      operation(resolved).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    ),
});

/** Keys are relative to the zone root. */
export const zoneKey = (key: string) => key.replace(/^\/+/, "");

const required = <A>(name: string, accessor: Effect.Effect<A | undefined>) =>
  Effect.flatMap(accessor, (value) =>
    value === undefined
      ? Effect.die(new Error(`Storage zone binding is missing its ${name}; is the capability's layer provided on this host?`))
      : Effect.succeed(value),
  );

/**
 * Bind a zone at `level` and build the client with `makeClient`. The
 * `HttpClient` comes from the layer ({@link storageZoneHttpLayer}).
 */
export const makeStorageZoneHttp = <Client>(options: {
  readonly level: StorageZoneAccessLevel;
  readonly makeClient: (http: StorageZoneHttp) => Client;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (zone: StorageZone) {
      // Yielding an Output binds it into the host (plan) and returns its
      // runtime accessor.
      const hostname = yield* zone.storageHostname;
      const zoneName = yield* zone.name;
      const password = options.level === "Read" ? yield* zone.readOnlyPassword : yield* zone.password;
      const access = Effect.all({
        hostname: required("hostname", hostname),
        zoneName: required("zone name", zoneName),
        password: required("password", password),
      });
      return options.makeClient(makeStorageZoneHttpClient(access, http));
    });
  });

export const storageZoneHttpLayer = FetchHttpClient.layer;
