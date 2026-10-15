# TanStack Start on bunny.net

- TanStack Start with SSR and server functions, running as an Edge Script (`Website.TanStackStart`). Client assets are served from a storage zone.
- A guestbook stored in a Bunny Database; `migrations/*.sql` are applied on every deploy.
- Stock Better Auth in its own Effect-native Edge Script (`auth/api.ts`, `BunnyDatabase` layer).
  - The site binds it in `env` (`AUTH_API: authApi`) and forwards `/api/auth/*` with `edgeScriptFetcher("AUTH_API")` (`src/auth-proxy.ts`).
  - The browser stays on one origin, and the auth script sees the site's URL.
  - Signing the guestbook requires a session.

```bash
bun install                       # at the repository root
cd examples/tanstack-start
BUNNY_API_KEY=... bun alchemy dev      # local dev server + real dev-stage database and auth script
BUNNY_API_KEY=... bun alchemy deploy
BUNNY_API_KEY=... bun alchemy destroy
```

Better Auth's schema migration is an Alchemy Action: this repository applies the [Alchemy patch](../../docs/getting-started.md#installation) it needs. See [Better Auth](../../docs/better-auth.md) and [Websites](../../docs/websites.md).
