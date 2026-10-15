/**
 * Bunny credentials — hand-written.
 *
 * The account API key authenticates the core API (https://api.bunny.net)
 * with an `AccessKey` header. The `Credentials` service holds an *effect*
 * that resolves the current credentials; the protocol resolves it on every
 * request, so a caller can provide different credentials around one call.
 *
 * Storage zone passwords (Edge Storage file API) are separate; see
 * `storage.ts`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ConfigError } from "@distilled.cloud/core/errors";

export const DEFAULT_API_BASE_URL = "https://api.bunny.net";

export interface Config {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config>
>()("BunnyCredentials") {}

/** Layer from an account API key and an optional base URL. */
export const fromApiKey = (config: {
  readonly apiKey: string | Redacted.Redacted<string>;
  readonly apiBaseUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey:
        typeof config.apiKey === "string"
          ? Redacted.make(config.apiKey)
          : config.apiKey,
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

/** Reads BUNNY_API_KEY (required) and BUNNY_API_BASE_URL (optional). */
export const CredentialsFromEnv: Layer.Layer<Credentials> = Layer.succeed(
  Credentials,
  Effect.gen(function* () {
    const apiKey = process.env.BUNNY_API_KEY;
    if (!apiKey) {
      return yield* new ConfigError({
        message: "BUNNY_API_KEY environment variable is required",
      });
    }
    return {
      apiKey: Redacted.make(apiKey),
      apiBaseUrl: process.env.BUNNY_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    };
  }).pipe(Effect.orDie),
);
