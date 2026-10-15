import { ConfigError, Credentials } from "alchemy-bunny-sdk";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BUNNY_AUTH_PROVIDER_NAME,
  type BunnyAuthConfig,
  type BunnyResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
} from "alchemy-bunny-sdk";

/**
 * Build a `Credentials` layer that resolves bunny.net credentials through the
 * Alchemy AuthProvider for the configured profile (defaults to "default",
 * overridable with `ALCHEMY_PROFILE`). Environment variables win when set.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        BunnyAuthConfig,
        BunnyResolvedCredentials
      >(BUNNY_AUTH_PROVIDER_NAME);

      return yield* resolve.pipe(
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve bunny.net credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
