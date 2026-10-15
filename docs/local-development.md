# Local development

`alchemy dev` works as it does for Alchemy's hosts without a local emulator (Neon, PlanetScale, Fly): bunny.net resources are created for real in your personal stage `dev_$USER`, separate from `alchemy deploy`'s `live_$USER`, and the app runs locally.

- `Website.TanStackStart` runs TanStack Start's own Vite dev server locally (on a port Alchemy picks), with the site's `env` in the process environment, and deploys nothing else for the site. Wrap it in `Alchemy.remote()` to deploy it in dev instead.
- `Website.StaticSite` with a `dev` option (`{ command, cwd?, env?, url? }`) runs that dev server locally and deploys nothing for the site; without `dev` it deploys to the dev stage.
- Databases, tokens, migrations, the Better Auth schema and Effect-native Edge Scripts are real resources in the dev stage, so the local app talks to a real Bunny Database and auth service.
- Not emulated:
  - The dev server runs in Node, not in bunny.net's Deno-based Edge Scripting runtime.
  - It is not behind the CDN.
  - Runtime limits, cold starts and pull zone behaviour are only exercised on deploy.
  - There is no local runtime for Effect-native Edge Scripts yet (Cloudflare has workerd).

Remove the dev stage with `bun alchemy destroy --stage dev_$USER`.

To test a bundle locally, run it under Deno: the SDK falls back to `Deno.serve` on port 8080 outside bunny.net.

```bash
bunx deno run -A bundle.mjs
```

The dev flow was verified before the [bindings](bindings.md) were added; it has not been re-run on the `env` binding between a site and an Edge Script.
