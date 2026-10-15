import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { EdgeRule } from "../EdgeRule.ts";
import { EdgeScript, expandEdgeScriptEnv } from "../EdgeScript.ts";
import type { StorageRegion } from "../internal.ts";
import { PullZoneHostname } from "../PullZoneHostname.ts";
import { PurgeCache } from "../PurgeCache.ts";
import { StorageDeployment } from "../StorageDeployment.ts";
import { StorageZone } from "../StorageZone.ts";

/** Alchemy's TanStack Start framework integration (the one every Alchemy host uses). */
export const TANSTACK_START_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/tanstack-start";

/**
 * The build target. TanStack Start's `dist/server/server.js` default-exports
 * a web-standard `{ fetch }` handler; the Node target builds it (in a child
 * process) exactly as for Fly, and the Edge Script serves that handler.
 */
export const TANSTACK_START_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/tanstack-start/node";

export type TanStackStartEnvValue = string | Redacted.Redacted<string> | undefined;

export interface TanStackStartProps {
  /** App directory (where `vite.config.ts` lives), relative to where Alchemy runs. */
  rootDir?: string;
  /** Build memoisation; see `Website.Server`. */
  memo?: MemoOptions | boolean;
  /**
   * The server's environment (`process.env`), like every Alchemy website's
   * `env`. On bunny.net a `Redacted` value becomes an Edge Script secret and
   * a string a variable; under `alchemy dev` the local dev server gets the
   * same values. Values may be Outputs (`db.url`, `token.token`).
   *
   * A `Bunny.EdgeScript` binds it like a service binding (see
   * `EdgeScriptProps.env`): `env: { AUTH_API: authApi }` gives
   * `AUTH_API_URL` and `AUTH_API_KEY`, and the server calls it with
   * `edgeScriptFetcher("AUTH_API")`.
   */
  env?: Record<string, Input<TanStackStartEnvValue> | EdgeScript>;
  /** `alchemy dev` options for the local dev server (see `Website.Server`). */
  dev?: ServerDevProps;
  /** Storage region for the client assets. @default "DE" */
  region?: StorageRegion;
  /** Storage replication regions. */
  replicationRegions?: StorageRegion[];
  /**
   * Root-level files from `public/` to serve from storage, e.g.
   * `["/favicon.ico", "/robots.txt"]`. `/assets/*` is always served from
   * storage; every other path goes to the server.
   */
  publicFiles?: string[];
  /** Custom hostnames on the server's pull zone, each with a free certificate. */
  domain?: string | string[];
}

/** Hashed client assets never change under the same name. */
const IMMUTABLE_TTL = 31_536_000;
const MAX_PATTERNS = 5;

const chunk = <A>(items: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );

const hostnameId = (hostname: string) =>
  `Hostname-${hostname.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

const reveal = (value: TanStackStartEnvValue) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

/** The environment as plain strings, for the build and the local dev server. */
const plainEnv = (env: TanStackStartProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          Output.isOutput(value)
            ? Output.map(value as Output.Output<TanStackStartEnvValue>, reveal)
            : reveal(value as TanStackStartEnvValue),
        ]),
      );

/**
 * A TanStack Start app (SSR + server functions) on bunny.net, built the way
 * Alchemy builds TanStack Start for every host (`Fly.Website.TanStackStart`,
 * `AWS.Website.TanStackStart`, ...): `Website.Server` drives the project's
 * own `vite.config.ts` — no bunny-specific plugin — and under `alchemy dev`
 * runs TanStack Start's dev server locally instead of deploying.
 *
 * On deploy, the server's fetch handler runs as a standalone Edge Script on
 * `*.bunny.run`, the hashed client assets go to a storage zone, and an edge
 * rule on the script's pull zone serves `/assets/*` from it with a one-year
 * browser cache.
 *
 * Module-level state is not shared between edge isolates; keep state in a
 * database.
 *
 * @example
 * ```ts
 * // vite.config.ts: plugins: [tanstackStart(), viteReact()]
 * const site = yield* Bunny.Website.TanStackStart("Website", {
 *   env: { GREETING: "Hello from TanStack Start on bunny.net!" },
 * });
 * return { url: site.url };
 * ```
 */
export const TanStackStart = (id: string, props: TanStackStartProps = {}) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;

    // Edge Scripts in `env` become their URL and key, for the build, the
    // local dev server and the deployed server alike.
    const env = (yield* expandEdgeScriptEnv(id, props.env)) as TanStackStartProps["env"];

    // Build (deploy) or dev server (`alchemy dev`): Alchemy's framework
    // integration, same as every other host.
    const build = yield* FrameworkServer("Build", {
      framework: TANSTACK_START_FRAMEWORK_SPECIFIER,
      target: TANSTACK_START_TARGET_SPECIFIER,
      root: props.rootDir,
      env: plainEnv(env) as Record<string, string | undefined> | undefined,
      memo: props.memo,
      dev: props.dev,
    });

    if (isLocal) {
      return {
        url: build.url,
        build,
        storageZone: undefined,
        assets: undefined,
        server: undefined,
        edgeRules: [],
        purge: undefined,
        hostnames: [],
      };
    }

    // The build runs at apply time, so its paths are Outputs.
    const distDir = build.distDir as unknown as Output.Output<string | undefined>;
    const clientDir = Output.map(build.clientDir as unknown as Output.Output<string | undefined>, (dir) => {
      if (dir === undefined) throw new Error("The TanStack Start build produced no client directory");
      return dir;
    });
    const serverEntry = Output.map(distDir, (dir) => {
      if (dir === undefined) throw new Error("The TanStack Start build produced no output directory");
      return `${dir}/server/server.js`;
    });

    // Client assets in a storage zone.
    const storageZone = yield* StorageZone("Assets", {
      region: props.region,
      replicationRegions: props.replicationRegions,
    });
    const assets = yield* StorageDeployment("AssetFiles", {
      storageZone,
      sourcePath: clientDir as unknown as string,
      prefix: "client",
      purge: true,
    });

    // The server's fetch handler as a standalone Edge Script.
    const server = yield* EdgeScript("Server", {
      main: serverEntry as unknown as string,
      fetchHandler: true,
      version: build.hash.output as unknown as string,
      env: env as Record<string, string | Redacted.Redacted<string>> | undefined,
    });

    // Static paths come from storage; everything else reaches the server.
    const pullZone = { pullZoneId: Output.map(server.pullZoneId, (pullZoneId) => pullZoneId ?? 0) };
    const fromStorage = { type: "OriginStorage", storageZone, pathPrefix: "/client/" } as const;
    const edgeRules = [
      yield* EdgeRule("AssetsFromStorage", {
        pullZone,
        action: fromStorage,
        when: { url: "*/assets/*" },
      }),
      yield* EdgeRule("AssetsImmutable", {
        pullZone,
        action: { type: "OverrideBrowserCacheTime", seconds: IMMUTABLE_TTL },
        when: { url: "*/assets/*" },
      }),
      ...(yield* Effect.forEach(chunk(props.publicFiles ?? [], MAX_PATTERNS), (paths, index) =>
        EdgeRule(`PublicFiles-${index + 1}`, {
          pullZone,
          action: fromStorage,
          when: { url: paths.map((path) => `*${path.startsWith("/") ? path : `/${path}`}`) },
        }),
      )),
    ];

    // Purge the CDN whenever the assets or the server change.
    const purge = yield* PurgeCache("Purge", {
      pullZone,
      version: Output.interpolate`${assets.version}-${server.codeHash}`,
    });

    const domains =
      props.domain === undefined ? [] : Array.isArray(props.domain) ? props.domain : [props.domain];
    const hostnames = yield* Effect.forEach(domains, (hostname) =>
      PullZoneHostname(hostnameId(hostname), { pullZone, hostname }),
    );

    const url = domains[0] !== undefined ? `https://${domains[0]}` : server.url;
    return { url, build, storageZone, assets, server, edgeRules, purge, hostnames };
  }).pipe(Namespace.push(id));
