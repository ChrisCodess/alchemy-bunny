import { Compute, Core, Retry } from "alchemy-bunny-sdk";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { initialCwd } from "alchemy/Util/Node";
import type { ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import {
  EdgeScript,
  type EdgeScriptAttributes,
  type EdgeScriptBinding,
  type EdgeScriptProps,
  type EdgeScriptType,
} from "./EdgeScript.ts";
import { withPullZoneLock } from "./internal.ts";


const SCRIPT_TYPE: Record<EdgeScriptType, 1 | 2> = { standalone: 1, middleware: 2 };

/**
 * Absolute path of `@bunny.net/edgescript-sdk`'s Deno build — the one that
 * calls `Bunny.v1.serve` on bunny.net. Bun and Node resolve the package to
 * its Node build (which starts a local HTTP server), so read the `deno`
 * entry from the package's exports map instead.
 */
const edgeSdkEntry = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.dirname(fileURLToPath(import.meta.resolve("@bunny.net/edgescript-sdk")));
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (yield* fs.exists(manifest)) {
      const pkg = JSON.parse(yield* fs.readFileString(manifest));
      if (pkg.name === "@bunny.net/edgescript-sdk") {
        return path.join(dir, pkg.exports?.["."]?.deno ?? "esm/lib.mjs");
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return yield* Effect.die(new Error("@bunny.net/edgescript-sdk is not installed"));
    }
    dir = parent;
  }
});

const FETCH_HANDLER_ENTRY = "\0alchemy-bunny:fetch-handler-entry";

/** A virtual entry that serves `entry`'s default-exported fetch handler. */
const fetchHandlerPlugin = (entry: string, sdk: string) => ({
  name: "alchemy-bunny:fetch-handler-entry",
  resolveId: (id: string) => (id === FETCH_HANDLER_ENTRY ? id : null),
  load: (id: string) =>
    id === FETCH_HANDLER_ENTRY
      ? [
          `import * as BunnySDK from ${JSON.stringify(sdk)};`,
          `import * as app from ${JSON.stringify(entry)};`,
          `const handler = app.default ?? app;`,
          `const fetchHandler = typeof handler === "function" ? handler : (request) => handler.fetch(request);`,
          `BunnySDK.net.http.serve((request) => fetchHandler(request));`,
        ].join("\n")
      : null,
});

const PLATFORM_ENTRY = "\0alchemy-bunny:platform-entry";

/**
 * Absolute path of this package's Edge Script bootstrap: `Runtime/Bootstrap.ts`
 * next to this module when it runs from `src` (Bun), `Runtime/Bootstrap.js`
 * when it runs from the compiled `lib` (Node).
 */
const bootstrapModule = () =>
  fileURLToPath(new URL(`./Runtime/Bootstrap.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

/**
 * The generated entry of an Effect-native script: the bootstrap and the
 * user's `main` (whose default export is the `EdgeScript` class), nothing
 * else — the same shim shape as Alchemy's Lambda/Worker entries.
 */
const platformEntryPlugin = (entry: string, bootstrap: string) => ({
  name: "alchemy-bunny:platform-entry",
  resolveId: (id: string) => (id === PLATFORM_ENTRY ? id : null),
  load: (id: string) =>
    id === PLATFORM_ENTRY
      ? [
          `import { bootstrap } from ${JSON.stringify(bootstrap)};`,
          `import entrypoint from ${JSON.stringify(entry)};`,
          `bootstrap(entrypoint);`,
        ].join("\n")
      : null,
});

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

/**
 * Builtins bunny.net's runtime cannot load (import fails with "failed to
 * resolve module"; probed 2026-09-29). One
 * static import of these fails the whole script, and plan-time code that is
 * never called at runtime still drags them in (e.g. Alchemy's platform
 * services, inlined from dynamic imports). Like workerd's `nodejs_compat`
 * stubs, they resolve to modules whose functions throw when called.
 */
const UNAVAILABLE_BUILTINS: Record<string, readonly string[]> = {
  child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "ChildProcess"],
  worker_threads: ["Worker", "isMainThread", "parentPort", "workerData", "threadId", "MessageChannel"],
  v8: ["serialize", "deserialize", "getHeapStatistics", "setFlagsFromString"],
  tty: ["isatty", "ReadStream", "WriteStream"],
  cluster: ["isPrimary", "isMaster", "isWorker", "fork", "workers"],
  vm: ["Script", "createContext", "isContext", "runInContext", "runInNewContext", "runInThisContext"],
  inspector: ["Session", "open", "close", "url"],
};
const UNAVAILABLE_PREFIX = "\0alchemy-bunny:unavailable:";

const unavailableStub = (name: string) =>
  [
    `const unavailable = (member) => () => { throw new Error("node:${name}" + (member ? "." + member : "") + " is not available on bunny.net Edge Scripting"); };`,
    ...UNAVAILABLE_BUILTINS[name]!.map((member) =>
      name === "tty" && member === "isatty"
        ? `export const isatty = () => false;`
        : `export const ${member} = unavailable(${JSON.stringify(member)});`,
    ),
    `export default new Proxy({}, { get: (_, member) => (${name === "tty" ? `member === "isatty" ? () => false : ` : ""}unavailable(String(member))) });`,
  ].join("\n");

/**
 * Node builtins on Deno (the Edge Scripting runtime): bare `fs`, `path`, ...
 * become external `node:fs`, `node:path` (Deno only resolves the `node:`
 * form; workerd accepts both), and the ones bunny.net cannot load become
 * throwing stubs.
 */
const nodeBuiltinsPlugin = {
  name: "alchemy-bunny:node-builtins",
  async resolveId(
    this: { resolve: (id: string, importer?: string, options?: { skipSelf?: boolean }) => Promise<unknown> },
    id: string,
    importer: string | undefined,
  ) {
    const bare = id.startsWith("node:") ? id.slice("node:".length) : id;
    const root = bare.split("/")[0]!;
    if (!NODE_BUILTINS.has(root) && !(root in UNAVAILABLE_BUILTINS)) return null;
    // Bun's builtin list includes npm names (`ws`, `undici`); a bare
    // specifier that resolves to an installed package is not a builtin.
    if (!id.startsWith("node:") && (await this.resolve(id, importer, { skipSelf: true }))) return null;
    if (root in UNAVAILABLE_BUILTINS) return { id: `${UNAVAILABLE_PREFIX}${root}` };
    return { id: `node:${bare}`, external: true };
  },
  load: (id: string) =>
    id.startsWith(UNAVAILABLE_PREFIX) ? unavailableStub(id.slice(UNAVAILABLE_PREFIX.length)) : null,
};

/** Bundle `main` into a single ESM file for the edge runtime. */
export const bundleEdgeScript = Effect.fn(function* (
  main: string,
  config?: Bundle.BundleConfig,
  options: { readonly fetchHandler?: boolean; readonly platform?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* Bundle.resolveMainPath(
    main.startsWith("file:") ? main : path.resolve(initialCwd, main),
  );
  const cwd = yield* Bundle.findCwdForBundle(entry);
  const wrapper = options.platform
    ? platformEntryPlugin(entry, bootstrapModule())
    : options.fetchHandler
      ? fetchHandlerPlugin(entry, yield* edgeSdkEntry())
      : undefined;
  const input = options.platform ? PLATFORM_ENTRY : options.fetchHandler ? FETCH_HANDLER_ENTRY : entry;
  const dir = yield* fs.makeTempDirectory({ prefix: "bunny-edge-script-" });
  const output = yield* Bundle.build(
    {
      ...config?.input,
      input,
      plugins: [nodeBuiltinsPlugin, config?.input?.plugins, wrapper],
      cwd,
      platform: "neutral",
      // `node:*` builtins are resolved (and stubbed where missing) by
      // `nodeBuiltinsPlugin`; URL imports stay external.
      external: (id) => /^(https?|jsr|npm):/.test(id),
      resolve: {
        conditionNames: ["deno", "import", "module", "default"],
        ...config?.input?.resolve,
      },
    },
    {
      ...config?.output,
      dir,
      format: "esm",
      entryFileNames: "index.js",
      codeSplitting: false,
    },
    config,
  ).pipe(Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)));
  const content = output.files[0].content;
  const code = typeof content === "string" ? content : new TextDecoder().decode(content);
  return { code, hash: output.hash };
});

const stripScheme = (hostname: string | null | undefined) =>
  hostname ? hostname.replace(/^https?:\/\//, "").replace(/\/$/, "") : undefined;

const toAttrs = (
  script: Compute.EdgeScriptModel,
  codeHash: string,
  cookies: boolean | undefined,
): EdgeScriptAttributes => {
  const linked = script.LinkedPullZones?.[0];
  const hostname = stripScheme(linked?.DefaultHostname ?? script.DefaultHostname);
  return {
    scriptId: script.Id ?? 0,
    name: script.Name ?? "",
    type: script.ScriptType === 2 ? "middleware" : "standalone",
    codeHash,
    releaseId:
      script.CurrentReleaseId !== undefined && script.CurrentReleaseId >= 0
        ? script.CurrentReleaseId
        : undefined,
    pullZoneId: linked?.Id,
    hostname,
    url: hostname ? `https://${hostname}` : undefined,
    cookies,
  };
};

/** Whether the linked pull zone passes cookies (`DisableCookies: false`). */
const linkedZoneCookies = (script: Compute.EdgeScriptModel) =>
  Effect.gen(function* () {
    const pullZoneId = script.LinkedPullZones?.[0]?.Id;
    if (pullZoneId === undefined) return undefined;
    const zone = yield* Core.getPullZone({ id: pullZoneId }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
    return zone === undefined ? undefined : zone.DisableCookies !== true;
  });

const getScript = (id: number) =>
  Compute.getEdgeScript({ id }).pipe(
    Effect.map((script) => (script.Deleted === true ? undefined : script)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findScriptByName = (name: string) =>
  Effect.gen(function* () {
    const scripts = yield* Compute.listEdgeScripts
      .items({ search: name, includeLinkedPullzones: true })
      .pipe(Stream.runCollect);
    const match = [...scripts].find(
      (script) => script.Name === name && script.Deleted !== true && script.Id !== undefined,
    );
    return match?.Id === undefined ? undefined : yield* getScript(match.Id);
  });

// bunny.net appends a suffix (e.g. "-15z0j") to the linked pull zone name,
// which must stay a DNS label.
const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 50 });

const secretValue = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

type EnvValue = string | Redacted.Redacted<string>;

/** Two sources set one env var of an Edge Script to different values. */
export class EdgeScriptEnvConflict extends Data.TaggedError("EdgeScriptEnvConflict")<{
  readonly name: string;
  readonly message: string;
}> {}

/** `env` holds a value the provider cannot deploy (the platform expands Edge Scripts). */
export class EdgeScriptEnvInvalid extends Data.TaggedError("EdgeScriptEnvInvalid")<{
  readonly name: string;
  readonly message: string;
}> {}

const splitEnv = (env: Record<string, EnvValue>) => {
  const variables: Record<string, string> = {};
  const secrets: Record<string, Redacted.Redacted<string>> = {};
  for (const [name, value] of Object.entries(env)) {
    if (Redacted.isRedacted(value)) secrets[name] = value;
    else variables[name] = value;
  }
  return { variables, secrets };
};

/** The props' env as plain values: strings and `Redacted`; `undefined` dropped. */
const propsEnv = (env: EdgeScriptProps["env"]) =>
  Effect.gen(function* () {
    const out: Record<string, EnvValue> = {};
    for (const [name, value] of Object.entries(env ?? {})) {
      if (value === undefined) continue;
      if (typeof value !== "string" && !Redacted.isRedacted(value)) {
        return yield* new EdgeScriptEnvInvalid({
          name,
          message: `env.${name} is not a string or Redacted value`,
        });
      }
      out[name] = value as EnvValue;
    }
    return out;
  });

type BindingRow = ResourceBinding<EdgeScriptBinding> & { readonly action?: string };

/**
 * Merge the env contributed by bindings (all but the ones being deleted)
 * into `base`, the props' env. A binding may not set a name `base` sets;
 * several bindings may set one name only to the same value (every caller of
 * a script binds the same key). Returns the merged env and the names whose
 * binding was created or changed.
 */
const mergeBindingEnv = (base: Record<string, EnvValue>, bindings: ReadonlyArray<BindingRow>) =>
  Effect.gen(function* () {
    const merged: Record<string, EnvValue> = { ...base };
    const fromBindings = new Map<string, string>();
    const changed = new Set<string>();
    for (const binding of bindings) {
      if (binding.action === "delete") continue;
      for (const [name, value] of Object.entries(binding.data?.env ?? {})) {
        if (value === undefined) continue;
        if (name in base) {
          return yield* new EdgeScriptEnvConflict({
            name,
            message: `env.${name} is set by the script's props and by the binding ${binding.sid}`,
          });
        }
        const previous = fromBindings.get(name);
        if (previous !== undefined && secretValue(merged[name]) !== secretValue(value)) {
          return yield* new EdgeScriptEnvConflict({
            name,
            message: `env.${name} is set to different values by the bindings ${previous} and ${binding.sid}`,
          });
        }
        fromBindings.set(name, binding.sid);
        merged[name] = value;
        if (binding.action === "create" || binding.action === "update") changed.add(name);
      }
    }
    return { env: merged, changed };
  });

/** An Effect-native script (class form): the platform leaves `isExternal` unset. */
const isEffectNative = (props: EdgeScriptProps) => props.isExternal !== true;

export const EdgeScriptProvider = () =>
  Provider.effect(
    EdgeScript,
    Effect.gen(function* () {
      const stack = yield* Stack;
      /**
       * The env the script runs with: the props' env, plus for an
       * Effect-native script what its bootstrap needs (`ALCHEMY_PHASE`, and
       * the stack name and stage for its `Stack`), as for Lambda.
       */
      const runtimeEnv = (props: EdgeScriptProps) =>
        Effect.map(propsEnv(props.env), (env): Record<string, EnvValue> =>
          isEffectNative(props)
            ? {
                ...env,
                ALCHEMY_PHASE: "runtime",
                ALCHEMY_STACK_NAME: stack.name,
                ALCHEMY_STAGE: stack.stage,
              }
            : env,
        );
      return {
    stables: ["scriptId", "type", "pullZoneId", "hostname", "url"],
    // Non-listable: bunny.net has no tags or labels to tell Alchemy's
    // scripts apart from others in the account.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news: input, output }) {
      // `exports` is the platform's runtime-context exports (Effects), never
      // a deploy input; leave it out of the resolved check.
      if (!isResolved({ ...(input as object), exports: undefined })) return undefined;
      const news = input as EdgeScriptProps;
      if (!output) return undefined;
      if ((news.type ?? "standalone") !== output.type) {
        return { action: "replace" } as const;
      }
      if (news.name !== undefined && news.name !== output.name) {
        return { action: "update" } as const;
      }
      const { hash } = yield* bundleEdgeScript(news.main, news.bundle, {
        fetchHandler: news.fetchHandler,
        platform: isEffectNative(news),
      });
      if (hash !== output.codeHash) return { action: "update" } as const;
      if ((news.type ?? "standalone") === "standalone" && (news.cookies ?? true) !== output.cookies) {
        return { action: "update" } as const;
      }
      // env and bindings: the engine compares old and new props and
      // binding data.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.scriptId !== undefined) {
        const script = yield* getScript(output.scriptId);
        return script === undefined
          ? undefined
          : toAttrs(script, output.codeHash, yield* linkedZoneCookies(script));
      }
      const explicitName = olds?.name;
      const script = yield* findScriptByName(explicitName ?? (yield* generatedName(id)));
      if (script === undefined) return undefined;
      // Unknown code hash: the next diff uploads the code again.
      const attrs = toAttrs(script, "", yield* linkedZoneCookies(script));
      return explicitName === undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output, session, bindings }) {
      const type = news.type ?? "standalone";
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const bundle = yield* bundleEdgeScript(news.main, news.bundle, {
        fetchHandler: news.fetchHandler,
        platform: isEffectNative(news),
      });

      // 1. Observe
      let script =
        output?.scriptId !== undefined ? yield* getScript(output.scriptId) : undefined;
      if (script === undefined) script = yield* findScriptByName(name);

      // 2. Ensure — the code goes in the create call, so bunny.net's starter
      // code is never published.
      let publish = false;
      if (script === undefined) {
        // Only throttling is retried: a create re-sent after a lost
        // response makes a second script.
        script = yield* Compute.createEdgeScript({
          Name: name,
          ScriptType: SCRIPT_TYPE[type],
          CreateLinkedPullZone: type === "standalone",
          Code: bundle.code,
        }).pipe(Retry.throttling);
        publish = true;
        yield* session.note(`Created ${type} edge script ${name}`);
      }
      const scriptId = script.Id ?? 0;

      // 3. Sync — name
      if (script.Name !== name) {
        yield* Compute.updateEdgeScript({ id: scriptId, Name: name, ScriptType: SCRIPT_TYPE[type] });
      }

      // Sync — code (compare with the live code, not with state)
      if (!publish) {
        const current = yield* Compute.getEdgeScriptCode({ id: scriptId });
        if (current.Code !== bundle.code) {
          yield* Compute.setEdgeScriptCode({ id: scriptId, Code: bundle.code });
          publish = true;
        }
      }

      // Env: the props' env plus what bindings contribute, split by shape:
      // Redacted → secret, string → variable.
      const { env, changed: changedByBindings } = yield* mergeBindingEnv(
        yield* runtimeEnv(news),
        bindings as ReadonlyArray<BindingRow>,
      );
      const { variables, secrets } = splitEnv(env);
      const oldSecrets = olds === undefined ? {} : splitEnv(yield* runtimeEnv(olds)).secrets;

      // Sync — variables
      const observedVariables = script.EdgeScriptVariables ?? [];
      for (const [variableName, value] of Object.entries(variables)) {
        const existing = observedVariables.find((variable) => variable.Name === variableName);
        if (existing?.DefaultValue !== value) {
          yield* Compute.upsertEdgeScriptVariable({
            id: scriptId,
            Name: variableName,
            DefaultValue: value,
            Required: false,
          });
          publish = true;
        }
      }
      for (const variable of observedVariables) {
        if (variable.Name && !(variable.Name in variables) && variable.Id !== undefined) {
          yield* Compute.deleteEdgeScriptVariable({ id: scriptId, variableId: variable.Id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          publish = true;
        }
      }

      // Sync — secrets. Values cannot be read back; upload a secret when it
      // is missing or its value differs from the previous props.
      const observedSecrets = (yield* Compute.listEdgeScriptSecrets({ id: scriptId })).Secrets ?? [];
      for (const [secretName, value] of Object.entries(secrets)) {
        const exists = observedSecrets.some((secret) => secret.Name === secretName);
        // A binding's secret is re-uploaded when its binding was created or
        // changed; a props secret when it differs from the previous props.
        const stale = changedByBindings.has(secretName)
          ? true
          : !(secretName in oldSecrets) && !(secretName in (news.env ?? {}))
            ? false
            : secretValue(oldSecrets[secretName]) !== secretValue(value);
        if (!exists || stale) {
          yield* Compute.upsertEdgeScriptSecret({ id: scriptId, Name: secretName, Secret: value });
          publish = true;
        }
      }
      for (const secret of observedSecrets) {
        if (secret.Name && !(secret.Name in secrets) && secret.Id !== undefined) {
          yield* Compute.deleteEdgeScriptSecret({ id: scriptId, secretId: secret.Id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          publish = true;
        }
      }

      // Publish a release when anything changed or none is live yet.
      if (publish || (script.CurrentReleaseId ?? -1) < 0) {
        yield* Compute.publishEdgeScript({
          id: scriptId,
          Note: `alchemy ${bundle.hash.slice(0, 12)}`,
        });
        yield* session.note(`Published ${name} (${bundle.hash.slice(0, 12)})`);
      }

      const live = (yield* getScript(scriptId)) ?? script;

      // Sync — cookies on the linked pull zone (standalone scripts).
      let cookies = yield* linkedZoneCookies(live);
      const pullZoneId = live.LinkedPullZones?.[0]?.Id;
      const wantCookies = news.cookies ?? true;
      if (type === "standalone" && pullZoneId !== undefined && cookies !== wantCookies) {
        yield* withPullZoneLock(pullZoneId)(
          Core.updatePullZone({ id: pullZoneId, DisableCookies: !wantCookies }),
        );
        cookies = wantCookies;
      }
      return toAttrs(live, bundle.hash, cookies);
    }),
    delete: Effect.fn(function* ({ output }) {
      // A standalone script's linked pull zone was created with it; remove it
      // too. Middleware is attached to pull zones Alchemy manages separately.
      yield* Compute.deleteEdgeScript({
        id: output.scriptId,
        deleteLinkedPullZones: output.type === "standalone",
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
      };
    }),
  );
