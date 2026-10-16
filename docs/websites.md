# Websites

Two composites under `Bunny.Website`, built like Alchemy's own website composites: `Fly.Website.*`, `AWS.Website.*` and `Cloudflare.Website.*`.

## `Website.StaticSite`

```ts
const site = yield* Bunny.Website.StaticSite("Site", {
  command: "bun run build", // optional; runs through Alchemy's Command.Build
  outdir: "dist",
  spa: true,                // unknown paths serve /index.html
  domain: "www.example.com",
});
return { url: site.url };
```

It builds, uploads to a storage zone (only changed files, HTML last, stale files purged), creates a pull zone in front, purges the CDN when files change, and attaches any `domain`s with free certificates.

- The edge TTL is 30 days, purged on every deploy. Browsers revalidate HTML (`max-age=0`) and cache assets for a day (`assetBrowserTtlSeconds`, or `false` to leave it alone). These are the defaults of bunny.net's own `bunny sites` CLI. bunny.net's default pull zone browser cache is `max-age=2592000` (30 days), which is why the composite overrides it.
- `spa: true` sets `Rewrite404To200` with `/index.html`; `notFoundPage` serves a custom 404 instead.
- `downloads: "/downloads/*"` forces `Content-Disposition: attachment` for matching paths.
- `middleware` attaches an Edge Script in front of the origin.
- `dev: { command, cwd?, env?, url? }` runs your dev server under `alchemy dev` instead of deploying.
- Other options: `cwd`, `env` (for the build command), `memo`, `region`, `replicationRegions`, `cache`, `purge`.
- `/about` and `/about/` both serve `about/index.html`.

## `Website.TanStackStart`

SSR and server functions on Edge Scripting, with a stock `vite.config.ts`:

```ts
// vite.config.ts: nothing bunny.net-specific
export default defineConfig({ plugins: [tanstackStart(), viteReact()] });

// alchemy.run.ts
const site = yield* Bunny.Website.TanStackStart("Website", {
  env: {
    BUNNY_DATABASE_URL: db.url,
    BUNNY_DATABASE_AUTH_TOKEN: token.token, // Redacted → secret
    AUTH_API: authApi,                      // an Edge Script → AUTH_API_URL + AUTH_API_KEY
  },
});
```

- Build and dev go through Alchemy's `Website.Server` with `@alchemy.run/frontend-frameworks/tanstack-start` and its Node target (install `@alchemy.run/frontend-frameworks@2.0.0-beta.83`), exactly as for Fly and AWS. Under `alchemy dev`, TanStack Start's own dev server runs locally with the same `env`.
- On deploy, `dist/server/server.js` (a web `{ fetch }` handler) becomes a standalone Edge Script with `fetchHandler`. `dist/client` goes to a storage zone. Edge rules serve `/assets/*` from storage with a one-year browser cache. Every other path reaches the server; list root files from `public/` in `publicFiles` to serve them from storage too.
- `env` is routed by shape like an Edge Script's: a `Redacted` value becomes a secret, a string a variable, and an Edge Script a binding read with `edgeScriptFetcher` ([Bindings](bindings.md#edge-script-to-edge-script)). Read values with `process.env`. The build gets the same values; they are not inlined into `dist` (checked for secrets).
- Options: `rootDir`, `memo`, `env`, `dev`, `region`, `replicationRegions`, `publicFiles`, `domain`.

Verified on the live runtime (2026-09-29):
- The stock Node-target build (React's Node streaming renderer) runs on Edge Scripting.
- SSR, route loaders and POST server functions work.
- TanStack's CSRF check refuses cross-origin requests (403).
- `AsyncLocalStorage`, `node:stream` and `node:buffer` work.
- The server script is about 2.5 MB (Alchemy's bundler default is `minify: "dce-only"`, as for Workers). A cold isolate answers in about 3 s, a warm one in about 0.1 s.

See [`examples/tanstack-start`](../examples/tanstack-start): a guestbook on Bunny Database, and Better Auth in its own Edge Script, bound into the site's `env`.
