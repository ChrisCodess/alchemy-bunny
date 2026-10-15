# Better Auth

Stock [`@alchemy.run/better-auth`](https://www.npmjs.com/package/@alchemy.run/better-auth), as in Alchemy's `cloudflare-better-auth` example: `BetterAuth()` inside an Effect-native Edge Script, with a database layer.

```bash
bun add @alchemy.run/better-auth@2.0.0-beta.79 better-auth@1.7.6 kysely@0.29.6
```

The schema migration is an Alchemy Action, so apply the [Alchemy patch](getting-started.md#installation) on `alchemy@2.0.0-beta.79`.

```ts
import { BetterAuth } from "@alchemy.run/better-auth";
import { BunnyDatabase } from "alchemy-bunny/BetterAuth";

export const AuthDb = Bunny.Database("AuthDb", {});

export default class AuthApi extends Bunny.EdgeScript<AuthApi>()(
  "AuthApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      advanced: { useSecureCookies: true },
    });
    return { fetch: auth.fetch };
  }).pipe(Effect.provide(BunnyDatabase(AuthDb))),
) {}
```

- `BetterAuth()` does what it does on a Cloudflare Worker: it generates and binds the signing secret (`BetterAuthSecret`) and registers the `BetterAuthMigrate` Action. That Action applies the schema before the script deploys and re-runs only when the schema, the database or the dialect changes.
- `BunnyDatabase(db)` is built like `CloudflareD1(db)`:
  - Better Auth runs on the [`QueryDatabase`](bindings.md#databases) binding's D1-compatible connection, through its D1 dialect. There are no interactive transactions, as with D1.
  - The migration connects through `QueryDatabaseLocal`, with a 15-minute token that is not stored.
  - The runtime token is `<db>QueryDatabaseToken`; see [Token revocation](database.md#token-revocation).
- `useSecureCookies: true` is needed because, without a static https `baseURL`, Better Auth does not know it serves HTTPS and leaves `Secure` off its cookies.

## Behind a site on the same origin

To keep the browser on one origin, a site forwards `/api/auth/*` to the auth script. Bind the script in the site's `env` and forward with `edgeScriptFetcher`. The auth script then handles each request as the site's URL, like a Cloudflare service binding ([Bindings](bindings.md#edge-script-to-edge-script)).

```ts
// alchemy.run.ts
const site = yield* Bunny.Website.TanStackStart("Website", { env: { AUTH_API: authApi } });

// src/routes/api/auth/$.ts (TanStack Start)
const authApi = edgeScriptFetcher("AUTH_API");
export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: ({ request }) => authApi.fetch(request), POST: ({ request }) => authApi.fetch(request) } },
});
```

Better Auth sees the site's origin and protocol without trusting forwarded headers. That matters on bunny.net for two reasons:
- bunny.net appends to `X-Forwarded-Proto` (`"https, https"`), which Better Auth rejects.
- Trusting `X-Forwarded-Host` from any caller would allow host-header injection.

With a fixed domain, you can instead give Better Auth a static `baseURL`.

Verified live (2026-09-29, the TanStack Start example):
- Sign-up sets the cookie `__Secure-better-auth.session_token; Path=/; HttpOnly; Secure; SameSite=Lax`.
- `get-session` works, and SSR sees the user.
- Sign-out works; a wrong password is 401; sign-in works.
- A cross-origin sign-in is 403.
- A sign-in sent straight to the auth script with a forged forwarded URL and no key or a wrong key is 403.
- The guestbook's POST server function is refused signed out, and stored under the user's name signed in.
