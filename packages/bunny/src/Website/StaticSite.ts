import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Command from "alchemy/Command";
import type { Input } from "alchemy/Input";
import type { BuildProps } from "alchemy/Command";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { EdgeRule } from "../EdgeRule.ts";
import type { StorageRegion } from "../internal.ts";
import { PullZone, type PullZoneCache } from "../PullZone.ts";
import { PullZoneHostname } from "../PullZoneHostname.ts";
import { PurgeCache } from "../PurgeCache.ts";
import { StorageDeployment } from "../StorageDeployment.ts";
import { StorageZone } from "../StorageZone.ts";

export interface StaticSiteProps {
  /** Build command. Omit to upload `outdir` as it is. */
  command?: string;
  /** Working directory for `command`; `outdir` is relative to it. */
  cwd?: string;
  /** Build output directory, or the directory to upload when there is no `command`. */
  outdir: string;
  /** Environment variables for the build command (values may be Outputs, e.g. an EdgeScript's `url`). */
  env?: Record<string, Input<string | Redacted.Redacted<string> | undefined>>;
  /** Build memoisation; see `Command.Build`. */
  memo?: BuildProps["memo"];
  /**
   * Single-page app: missing paths without a file extension serve
   * `/index.html` with status 200.
   * @default false
   */
  spa?: boolean;
  /** File served for missing paths, e.g. `/404.html`. Ignored with `spa`. */
  notFoundPage?: string;
  /** Primary storage region. @default "DE" */
  region?: StorageRegion;
  /** Storage replication regions. */
  replicationRegions?: StorageRegion[];
  /**
   * Custom hostnames. Each gets a free certificate once its DNS CNAMEs to
   * the CDN hostname (`pullZone.hostname`).
   */
  domain?: string | string[];
  /** Cache TTLs. @default {@link DEFAULT_SITE_CACHE} */
  cache?: PullZoneCache;
  /** Delete files that are not part of the current build. @default true */
  purge?: boolean;
  /**
   * Browser cache TTL (seconds) for static assets, by file extension (css,
   * js, fonts, images, wasm, …); HTML keeps the zone's browser TTL (0), so a
   * new deploy shows immediately. `false` disables the asset rules.
   * @default 86400 — 1 day, the official Bunny CLI's value for sites whose
   * asset names are not content-hashed
   */
  assetBrowserTtlSeconds?: number | false;
  /**
   * URL paths served as downloads (`Content-Disposition: attachment`), e.g.
   * `"/downloads/*"`. At most 5.
   */
  downloads?: string | string[];
  /** Middleware Edge Script in front of the site (an `EdgeScript` with `type: "middleware"`). */
  middleware?: { readonly scriptId: Input<number> };
  /** Under `alchemy dev`, run this dev server instead of deploying. */
  dev?: {
    command: string;
    url?: string;
    cwd?: string;
    env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  };
}

/**
 * Edge caches for 30 days (every deploy purges it); browsers revalidate on
 * every request. The official Bunny CLI `sites` command uses the same pair.
 */
export const DEFAULT_SITE_CACHE: PullZoneCache = {
  edgeTtlSeconds: 2_592_000,
  browserTtlSeconds: 0,
};

/** Extension groups (at most 5 patterns per rule), as in the official Bunny CLI. */
export const ASSET_EXTENSION_GROUPS = [
  ["css", "js", "mjs", "woff2", "svg"],
  ["png", "jpg", "jpeg", "webp", "ico"],
  ["wasm", "onnx", "woff", "ttf", "otf"],
] as const;

const DEFAULT_ASSET_BROWSER_TTL = 86_400;

const toUrlPattern = (path: string) =>
  path.startsWith("*") ? path : `*${path.startsWith("/") ? path : `/${path}`}`;

const hostnameId = (hostname: string) =>
  `Hostname-${hostname.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

/**
 * A static site on bunny.net: build, a storage zone, a file sync, a pull
 * zone in front, a cache purge whenever files change, and optional custom
 * hostnames.
 *
 * @example
 * ```typescript
 * const site = yield* Bunny.Website.StaticSite("Site", {
 *   command: "bun run build",
 *   outdir: "dist",
 *   spa: true,
 * });
 * return { url: site.url };
 * ```
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;

    // `alchemy dev` with a dev command: run the dev server, deploy nothing.
    if (ctx.dev && remoted !== true && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: props.dev.env,
      });
      const url = Output.map(dev.url, (url) => url ?? props.dev?.url);
      return {
        build: undefined,
        storageZone: undefined,
        files: undefined,
        pullZone: undefined,
        purge: undefined,
        edgeRules: [],
        hostnames: [],
        url,
        urls: [url],
      };
    }

    const build = props.command
      ? yield* Command.Build("Build", {
          command: props.command,
          cwd: props.cwd,
          outdir: props.outdir,
          env: props.env,
          memo: props.memo,
        })
      : undefined;
    const sourcePath =
      build?.outdir ?? (props.cwd ? `${props.cwd}/${props.outdir}` : props.outdir);

    const errorHandling = props.spa
      ? { rewrite404To200: true, custom404FilePath: "/index.html" }
      : props.notFoundPage
        ? { custom404FilePath: props.notFoundPage }
        : {};
    const storageZone = yield* StorageZone("Storage", {
      region: props.region,
      replicationRegions: props.replicationRegions,
      ...errorHandling,
    });

    const files = yield* StorageDeployment("Files", {
      storageZone,
      sourcePath,
      purge: props.purge ?? true,
    });

    const pullZone = yield* PullZone("Cdn", {
      origin: { storageZone },
      cache: props.cache ?? DEFAULT_SITE_CACHE,
      middleware: props.middleware,
    });

    const assetTtl = props.assetBrowserTtlSeconds ?? DEFAULT_ASSET_BROWSER_TTL;
    const assetRules =
      assetTtl === false
        ? []
        : yield* Effect.forEach(ASSET_EXTENSION_GROUPS, (extensions, index) =>
            EdgeRule(`AssetCache-${index + 1}`, {
              pullZone,
              action: { type: "OverrideBrowserCacheTime", seconds: assetTtl },
              when: { extension: extensions },
            }),
          );
    const downloadPaths =
      props.downloads === undefined
        ? []
        : Array.isArray(props.downloads)
          ? props.downloads
          : [props.downloads];
    const downloadRule =
      downloadPaths.length > 0
        ? yield* EdgeRule("Downloads", {
            pullZone,
            action: { type: "ForceDownload" },
            when: { url: downloadPaths.map(toUrlPattern) },
          })
        : undefined;

    const purge = yield* PurgeCache("Purge", {
      pullZone,
      version: files.version,
    });

    const domains =
      props.domain === undefined
        ? []
        : Array.isArray(props.domain)
          ? props.domain
          : [props.domain];
    const hostnames = yield* Effect.forEach(domains, (hostname) =>
      PullZoneHostname(hostnameId(hostname), { pullZone, hostname }),
    );

    const url = domains[0] !== undefined ? `https://${domains[0]}` : pullZone.url;
    return {
      build,
      storageZone,
      files,
      pullZone,
      purge,
      edgeRules: downloadRule ? [...assetRules, downloadRule] : assetRules,
      hostnames,
      url,
      urls: [pullZone.url, ...domains.map((hostname) => `https://${hostname}`)],
    };
  }).pipe(Namespace.push(id));
