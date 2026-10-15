import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import { Server as WebsiteServer, ServerProvider as WebsiteServerProvider } from "alchemy/Website/Server";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BunnyAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { DatabaseToken, DatabaseTokenProvider } from "./DatabaseToken.ts";
import { EdgeRule, EdgeRuleProvider } from "./EdgeRule.ts";
import { EdgeScript } from "./EdgeScript.ts";
import { EdgeScriptProvider } from "./EdgeScriptProvider.ts";
import { PullZone, PullZoneProvider } from "./PullZone.ts";
import { PullZoneHostname, PullZoneHostnameProvider } from "./PullZoneHostname.ts";
import { PurgeCache, PurgeCacheProvider } from "./PurgeCache.ts";
import { StorageDeployment, StorageDeploymentProvider } from "./StorageDeployment.ts";
import { StorageZone, StorageZoneProvider } from "./StorageZone.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Bunny") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers the bunny.net resource providers, the
 * bunny.net `AuthProvider`, the resolved `Credentials`, an `HttpClient`,
 * `Alchemy.Random` (generated secrets, e.g. a Better Auth secret),
 * `Website.Server` (framework builds and dev servers, as for every Alchemy
 * host) and the `Command` providers (static site builds). Merge it with
 * other clouds' `providers()`.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as Bunny from "alchemy-bunny";
 *
 * export default Alchemy.Stack(
 *   "MySite",
 *   { providers: Bunny.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const site = yield* Bunny.Website.StaticSite("Site", { outdir: "public" });
 *     return { url: site.url };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Database,
      DatabaseToken,
      EdgeRule,
      EdgeScript,
      PullZone,
      PullZoneHostname,
      PurgeCache,
      Random,
      StorageDeployment,
      StorageZone,
      WebsiteServer,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DatabaseProvider(),
        DatabaseTokenProvider(),
        EdgeRuleProvider(),
        EdgeScriptProvider(),
        PullZoneProvider(),
        PullZoneHostnameProvider(),
        PurgeCacheProvider(),
        RandomProvider(),
        StorageDeploymentProvider(),
        StorageZoneProvider(),
        WebsiteServerProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(BunnyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
