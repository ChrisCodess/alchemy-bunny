// docs/better-auth.md: stock @alchemy.run/better-auth in an Effect-native
// Edge Script, on a Bunny Database.
import { BetterAuth } from "@alchemy.run/better-auth";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";
import { BunnyDatabase } from "alchemy-bunny/BetterAuth";

export const AuthDb = Bunny.Database("AuthDb", {});

export default class AuthApi extends Bunny.EdgeScript<AuthApi>()(
  "AuthApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      // Behind a site that forwards to it (see docs/better-auth.md), Better
      // Auth cannot tell it serves HTTPS without a static https baseURL.
      advanced: { useSecureCookies: true },
    });
    return { fetch: auth.fetch };
  }).pipe(Effect.provide(BunnyDatabase(AuthDb))),
) {}
