import { BetterAuth } from "@alchemy.run/better-auth";
import * as Effect from "effect/Effect";
import { BunnyDatabase } from "../../src/BetterAuth.ts";
import { Database } from "../../src/Database.ts";
import { EdgeScript } from "../../src/EdgeScript.ts";

export const AuthDb = Database("AuthDb", {});

/** Stock `@alchemy.run/better-auth` in an Effect-native Edge Script. */
export default class AuthApi extends EdgeScript<AuthApi>()(
  "AuthApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      user: { additionalFields: { nickname: { type: "string", required: false } } },
    });
    return { fetch: auth.fetch };
  }).pipe(Effect.provide(BunnyDatabase(AuthDb))),
) {}
