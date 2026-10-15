import type * as Bundle from "alchemy/Bundle";
import type { Output } from "alchemy/Output";
import { Random } from "alchemy/Random";
import { Platform, type Main } from "alchemy/Platform";
import { isResourceOfType, type Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { edgeScriptEnvNames, FETCH_KEY_ENV } from "./EdgeScriptFetch.ts";
import { fetchKeyOf } from "./EdgeScriptFetchKey.ts";
import {
  EDGE_SCRIPT_TYPE,
  makeEdgeScriptRuntimeContext,
  type EdgeScriptContext,
} from "./EdgeScriptRuntime.ts";
import type { Providers } from "./Providers.ts";

export type EdgeScriptType = "standalone" | "middleware";

export interface EdgeScriptProps {
  /**
   * Entry file (TypeScript or JavaScript), relative to the directory Alchemy
   * runs in, or a `file://` URL. It is bundled into one ESM file with
   * rolldown, resolving packages with the `deno` export condition (the
   * runtime is Deno-based). `node:*` and URL imports stay external.
   */
  main: string;
  /**
   * `standalone` answers requests itself on its own `*.bunny.run` hostname
   * (bunny.net creates a linked pull zone for it). `middleware` runs in
   * front of a pull zone's origin; attach it with `PullZone({ middleware })`.
   * Changing it replaces the script.
   * @default "standalone"
   */
  type?: EdgeScriptType;
  /**
   * `main`'s default export is a web `fetch` handler — an object with
   * `fetch(request)` or a function — such as a framework server build
   * (TanStack Start's `dist/server/server.js`). Alchemy generates the
   * `BunnySDK.net.http.serve` entry around it.
   * @default false
   */
  fetchHandler?: boolean;
  /** Script name. Generated from the stack, stage and logical ID when omitted. */
  name?: string;
  /**
   * Environment, routed by shape like a Cloudflare Worker's `env`: a
   * `Redacted<string>` becomes an Edge Script secret (never read back from
   * bunny.net), a string becomes a variable. Read either with
   * `process.env.NAME` or `Deno.env.get("NAME")`.
   *
   * Another `Bunny.EdgeScript` binds it like a Cloudflare service binding
   * (`env: { API: api }`): it becomes `API_URL` and `API_KEY` (a secret),
   * read with `edgeScriptFetcher("API")` from
   * `alchemy-bunny/EdgeScriptFetch`. The callee handles those
   * requests as the URL they were addressed to.
   */
  env?: Record<string, EdgeScriptEnvValue>;
  /**
   * Set by the platform: `true` for a bundled file (`EdgeScript(id, props)`),
   * unset for an Effect-native class, whose bundle is generated around it.
   * @internal
   */
  isExternal?: boolean;
  /** Set by the platform (the runtime context's exports). @internal */
  exports?: Record<string, any>;
  /** rolldown overrides (see `alchemy/Bundle`). */
  bundle?: Bundle.BundleConfig;
  /**
   * Any value produced by what `main` imports, e.g. `Command.Build`'s
   * `hash.output` when `main` wraps a framework's build output. Referencing
   * it orders this script after that build, and a change re-bundles it.
   */
  version?: string;
  /**
   * Standalone scripts: let cookies through the linked pull zone, both
   * `Cookie` to the script and `Set-Cookie` back. bunny.net creates the
   * zone with cookies disabled, which breaks sessions (Better Auth, any
   * login) without an error.
   * @default true
   */
  cookies?: boolean;
}

export interface EdgeScriptAttributes {
  /** Numeric script id. */
  scriptId: number;
  name: string;
  type: EdgeScriptType;
  /** SHA-256 of the deployed bundle. */
  codeHash: string;
  /** Id of the live release. */
  releaseId: number | undefined;
  /** Standalone scripts: the pull zone bunny.net linked to the script. */
  pullZoneId: number | undefined;
  /** Standalone scripts: `<name>-<suffix>.bunny.run`. */
  hostname: string | undefined;
  /** Standalone scripts: `https://<hostname>`. */
  url: string | undefined;
  /** Standalone scripts: whether the linked pull zone passes cookies. */
  cookies: boolean | undefined;
}

/** A value of an `EdgeScript`'s `env` map. */
export type EdgeScriptEnvValue = string | Redacted.Redacted<string> | EdgeScript;

/**
 * What bindings attach to an Edge Script (its Binding Contract): env vars,
 * like `AWS.Lambda.Function`'s and `Prisma.Compute`'s. `Redacted` values
 * become secrets. Several bindings may set the same name only to the same
 * value, and none may set a name `env` sets.
 */
export interface EdgeScriptBinding {
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface EdgeScript
  extends Resource<"Bunny.EdgeScript", EdgeScriptProps, EdgeScriptAttributes, EdgeScriptBinding, Providers> {}

const isEdgeScript = (value: unknown): value is EdgeScript => isResourceOfType(value, EDGE_SCRIPT_TYPE);

/**
 * Expand the `EdgeScript` values of an `env` map (see `EdgeScriptProps.env`)
 * into `<NAME>_URL` and `<NAME>_KEY`, and bind the callee's key
 * (`ALCHEMY_FETCH_KEY`, one `Alchemy.Random` per callee) onto the callee.
 * Plan-time only; returns `env` unchanged when it holds no Edge Script.
 *
 * @internal Used by `EdgeScript` (its `transformProps` hook) and by
 * composites that also need the expanded values elsewhere (a framework
 * build, a local dev server).
 */
export const expandEdgeScriptEnv = (
  callerId: string,
  env: Record<string, EdgeScriptEnvValue | Output<any> | unknown> | undefined,
) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__ || env === undefined || !Object.values(env).some(isEdgeScript)) {
      return env as Record<string, any> | undefined;
    }
    const expanded: Record<string, any> = {};
    for (const [name, value] of Object.entries(env)) {
      if (!isEdgeScript(value)) {
        expanded[name] = value;
        continue;
      }
      const key = yield* fetchKeyOf((keyId) => Random(keyId), value);
      yield* value.bind(`${FETCH_KEY_ENV}:${callerId}`, { env: { [FETCH_KEY_ENV]: key.text } });
      const names = edgeScriptEnvNames(name);
      expanded[names.url] = value.url;
      expanded[names.key] = key.text;
    }
    return expanded;
  });

/** What an Effect-native script's `impl` returns: `{ fetch }` (an `HttpEffect`). */
export type EdgeScriptShape = Main<never>;

/**
 * A bunny.net Edge Script — the bunny.net host, like `Cloudflare.Worker`.
 *
 * **Bundled file** — `main` is bundled as-is (it calls
 * `BunnySDK.net.http.serve` itself, or set `fetchHandler` for a module that
 * default-exports a web fetch handler):
 *
 * ```typescript
 * const api = yield* Bunny.EdgeScript("Api", {
 *   main: "./edge/api.ts",
 *   env: { GREETING: "hello", API_KEY: Redacted.make("…") },
 * });
 * ```
 *
 * **Effect-native** — like `Cloudflare.Worker`, the class's init effect runs
 * at deploy time to collect bindings (resource Outputs, `Config`,
 * `Alchemy.Random`, …) into the script's env — `Redacted` values as secrets —
 * and again in the deployed script, where the returned `fetch` serves
 * requests:
 *
 * ```typescript
 * export default class Api extends Bunny.EdgeScript<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return { fetch: Effect.succeed(HttpServerResponse.text("hello")) };
 *   }),
 * ) {}
 * ```
 *
 * A `standalone` script is live at `url` (`*.bunny.run`). A `middleware`
 * script runs in front of a pull zone's origin once attached with
 * `PullZone({ middleware: script })`.
 * @see https://bunny.net/docs/scripting
 *
 * @resource
 */
export const EdgeScript: Platform<EdgeScript, never, EdgeScriptShape, EdgeScriptContext> = Platform(
  EDGE_SCRIPT_TYPE,
  {
    createRuntimeContext: makeEdgeScriptRuntimeContext,
    transformProps: (id: string, props: EdgeScriptProps) =>
      Effect.map(expandEdgeScriptEnv(id, props.env), (env) => (env === props.env ? props : { ...props, env })),
  },
);
