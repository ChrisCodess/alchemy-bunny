import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Bunny from "alchemy-bunny";
import AuthApi from "./auth/api.ts";
import { Db } from "./auth/database.ts";

export default Alchemy.Stack(
  "TanStackStartOnBunny",
  {
    providers: Bunny.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // The Bunny Database; migrations/*.sql are applied on every deploy.
    const db = yield* Db;
    const dbToken = yield* Bunny.DatabaseToken("DbToken", { database: db });

    // Better Auth as an Effect-native Edge Script (stock @alchemy.run/better-auth).
    const authApi = yield* AuthApi;

    // `alchemy deploy`: build, client assets to a storage zone, the server as
    // an Edge Script. `alchemy dev`: TanStack Start's dev server, locally,
    // with the same env. `AUTH_API: authApi` binds the auth script like a
    // service binding (`AUTH_API_URL` + `AUTH_API_KEY`, read with
    // `edgeScriptFetcher("AUTH_API")`).
    const site = yield* Bunny.Website.TanStackStart("Website", {
      env: {
        BUNNY_DATABASE_URL: db.url,
        BUNNY_DATABASE_AUTH_TOKEN: dbToken.token,
        AUTH_API: authApi,
      },
    });

    return { url: site.url, authUrl: authApi.url };
  }),
);
