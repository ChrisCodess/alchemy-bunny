# Edge Scripts

`Bunny.EdgeScript` is bunny.net's compute (Edge Scripting, a Deno-based runtime) as an Alchemy host — built on Alchemy's `Platform`, the same machinery as `Cloudflare.Worker` and `AWS.Lambda.Function`. A script is either a bundled file or an Effect-native class.

## Bundled file

`main` is bundled with rolldown into one ESM file and uploaded. It calls `BunnySDK.net.http.serve` itself:

```ts
// hello.ts
import * as BunnySDK from "@bunny.net/edgescript-sdk";

BunnySDK.net.http.serve((request) => new Response(`${process.env.GREETING} from ${new URL(request.url).pathname}`));
```

```ts
const hello = yield* Bunny.EdgeScript("Hello", {
  main: "./hello.ts",
  env: { GREETING: "hello", API_TOKEN: Redacted.make("…") }, // string → variable, Redacted → secret
});
// hello.url === "https://<name>-<suffix>.bunny.run"
```

With `fetchHandler: true`, `main` instead default-exports a web fetch handler (`{ fetch(request) }` or a function) — a framework's server build, for example — and the provider generates the `serve` call around it.

## Effect-native

```ts
export default class Api extends Bunny.EdgeScript<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const greeting = yield* Config.String("GREETING");                     // bound at deploy
    const signingKey = yield* (yield* Alchemy.Random("SigningKey")).text;  // a generated secret
    return {
      fetch: Effect.gen(function* () {
        const key = yield* signingKey;
        return HttpServerResponse.text(greeting);
      }),
    };
  }),
) {}
```

- **At deploy** the init effect runs under the host's runtime context: every resource Output, `Config` value and `Random` it reads is bound into the script's environment — `Redacted` values as secrets — plus `ALCHEMY_PHASE=runtime`, `ALCHEMY_STACK_NAME` and `ALCHEMY_STAGE`. [Bindings](bindings.md) (capabilities) attach here too.
- **The bundle** is a generated entry — `alchemy-bunny/Runtime/Bootstrap` plus `main`, like Alchemy's Lambda and Worker shims. At runtime the bootstrap builds the instance layers once per isolate, runs the same init with the values read back from `process.env`, and serves `fetch` with a fresh scope per request.
- The module's **default export** must be the class: the generated entry imports it.

## Environment

`env` is routed by shape, like a Cloudflare Worker's:

| Value | Becomes |
| --- | --- |
| `string` | a variable |
| `Redacted<string>` | a secret (never read back from bunny.net) |
| another `Bunny.EdgeScript` | `<NAME>_URL` + `<NAME>_KEY`, a service-binding-like call ([Bindings](bindings.md#edge-script-to-edge-script)) |

Read values with `process.env.NAME` or `Deno.env.get("NAME")`. Capabilities and bindings add env vars through the script's Binding Contract (`{ env }`, as for `Prisma.Compute`): a name may not be set both by `env` and by a binding (`EdgeScriptEnvConflict`), and several bindings may set one name only to the same value.

## Standalone and middleware

- `type: "standalone"` (default): bunny.net creates a linked pull zone and the script answers on `url` (`*.bunny.run`). The script is created with its code, so bunny.net's starter code is never served.
- `type: "middleware"`: runs in front of a pull zone's origin; attach it with `PullZone({ middleware: script })` or `Website.StaticSite({ middleware })`. It has no `url`.

**Cookies.** bunny.net creates every pull zone — including a script's linked zone — with `DisableCookies: true`, which strips `Cookie` from requests and `Set-Cookie` from responses and silently breaks logins. `cookies` (default `true`) turns cookies on for a standalone script's zone; set `cookies: false` to keep bunny.net's default.

## Runtime notes

- **Builtins.** Deno resolves only the `node:` form, so bare builtin imports (`fs`, `path`) are rewritten to `node:*`. bunny.net cannot load `node:child_process`, `worker_threads`, `v8`, `tty`, `cluster`, `vm` or `inspector`; they are stubbed with functions that throw if called (as workerd's `nodejs_compat` does), because plan-time code Alchemy pulls into bundles imports some of them. Loadable: `fs`, `crypto`, `stream`, `buffer`, `http`, `https`, `zlib`, `async_hooks` (`AsyncLocalStorage`), `url`, `path`, `events`, `util` and more (probed 2026-09-29).
- **Limits** (bunny.net): 10 MB script, 128 MB memory, 500 ms startup, 30 s CPU per request.
- **Isolates.** Module state is per isolate and not shared; keep state in a database. A new release takes about 20 s to reach every isolate, so old and new code answer side by side briefly after a deploy.
- **Cold starts** are slow for large bundles: about 3 s for a 2.5 MB server bundle, 0.1 s warm (measured from Southeast Asia to the default region).
- **Headers.** bunny.net keeps `X-Forwarded-Host` but *appends* to `X-Forwarded-Proto` (`"https, https"`), which libraries that expect exactly `http` or `https` reject.
- The `@bunny.net/edgescript-sdk` package resolves to its Node build under Bun and Node; the bundler uses its Deno build (the one that calls `Bunny.v1.serve`).

## Local development

Under `alchemy dev`, Effect-native scripts are deployed for real in the dev stage; there is no local Edge Scripting runtime yet. See [Local development](local-development.md).
