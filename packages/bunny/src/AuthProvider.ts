import { DEFAULT_API_BASE_URL } from "alchemy-bunny-sdk";
import { getEnv, getEnvRedactedRequired } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const BUNNY_AUTH_PROVIDER_NAME = "Bunny";
export const BUNNY_API_KEY_ENV = "BUNNY_API_KEY";
export const BUNNY_API_BASE_URL_ENV = "BUNNY_API_BASE_URL";

export type BunnyAuthConfig = StoredAuthConfig;

export type BunnyResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: BunnyAuthConfig["method"] | "env"; details?: string };
};

const bunnyAuth = makeStoredAuthProvider<BunnyResolvedCredentials>({
  provider: BUNNY_AUTH_PROVIDER_NAME,
  fields: [
    { name: "apiKey", label: "bunny.net account API key", secret: true },
    {
      name: "apiBaseUrl",
      label: "bunny.net API endpoint",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    apiKey: getEnvRedactedRequired(BUNNY_API_KEY_ENV),
    apiBaseUrl: getEnv(BUNNY_API_BASE_URL_ENV),
  }).pipe(
    Effect.map(({ apiKey, apiBaseUrl }) => ({
      type: "apiKey" as const,
      apiKey,
      apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
      source: {
        type: "env" as const,
        details: apiBaseUrl
          ? `${BUNNY_API_KEY_ENV}, ${BUNNY_API_BASE_URL_ENV}`
          : BUNNY_API_KEY_ENV,
      },
    })),
  ),
  environment: [
    { name: BUNNY_API_KEY_ENV, required: true, secret: true },
    { name: BUNNY_API_BASE_URL_ENV, required: false },
  ],
});

/**
 * Layer that registers the bunny.net {@link AuthProvider} into the
 * `AuthProviders` registry.
 *
 * Auth is the account API key (`BUNNY_API_KEY`, dashboard → Account → API).
 * An optional `BUNNY_API_BASE_URL` overrides the API root.
 */
export const BunnyAuth = bunnyAuth.layer;
