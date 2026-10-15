import * as Bunny from "alchemy-bunny";
import { BunnyDatabase } from "alchemy-bunny/BetterAuth";
import { BetterAuth } from "@alchemy.run/better-auth";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Db } from "./database.ts";

/**
 * Better Auth as its own Effect-native Edge Script — the stock
 * `@alchemy.run/better-auth` setup (see Alchemy's `cloudflare-better-auth`
 * example): `BetterAuth()` in the host's init with a database layer. Alchemy
 * binds the database (`Bunny.QueryDatabase`), generates and binds the
 * signing secret, and applies the schema before the script deploys.
 *
 * The site binds this script in its `env` (`AUTH_API: authApi`) and
 * forwards `/api/auth/*` here with `edgeScriptFetcher("AUTH_API")`. As with
 * a Cloudflare service binding, each request is handled as the URL the site
 * received (its origin, protocol and cookies). Set `AUTH_BASE_URL` to pin
 * the origin instead.
 */
export default class AuthApi extends Bunny.EdgeScript<AuthApi>()(
  "AuthApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const baseURL = yield* Config.String("AUTH_BASE_URL").pipe(Config.option);
    const auth = yield* BetterAuth({
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      baseURL: Option.getOrUndefined(baseURL),
      // Without a static https `baseURL` Better Auth cannot tell it is
      // serving HTTPS; browsers also accept Secure cookies on localhost.
      advanced: { useSecureCookies: true },
    });
    return { fetch: auth.fetch };
  }).pipe(Effect.provide(BunnyDatabase(Db))),
) {}
