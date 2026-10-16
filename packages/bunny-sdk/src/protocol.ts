/**
 * BunnyProtocol — hand-written.
 *
 * The core and compute APIs speak plain JSON REST authenticated with an
 * `AccessKey` header, so the protocol is one `makeRestProtocol` call:
 *
 *   request:  credentials → `AccessKey: <apiKey>` + base URL, resolved from
 *             the calling fiber on every request
 *
 *   response: 2xx JSON is the payload (sensitive members delivered as
 *             `Redacted`). Only 400 responses carry an error body,
 *             `{ ErrorKey, Field, Message }`; 401/404/500 bodies are empty or
 *             `{ Message }`. Failures map to the operation's typed error
 *             classes (matchers first, then status), then the shared
 *             HTTP-status classes, then {@link UnknownBunnyError}. In strict
 *             response validation a 2xx body that does not match the
 *             output schema fails with {@link BunnyParseError}.
 *
 * The database API (https://api.bunny.net/database) takes the same
 * `AccessKey` but answers errors as `{ error, details? }` (or plain text
 * for malformed paths and query strings): {@link BunnyDatabaseProtocol}.
 */
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as API from "@distilled.cloud/core/api";
import { makeRestProtocol, type RestErrorInfo, type RestParseErrorInfo } from "@distilled.cloud/core/protocol-rest";
import type { API_ERRORS, ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, type Config } from "./credentials.ts";
import { BunnyParseError, UnknownBunnyError } from "./errors.ts";

/** Error channel shared by every generated Bunny operation. */
export type BunnyOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | UnknownBunnyError
  | BunnyParseError
  | ConfigError
  | HttpClientError.HttpClientError;

/** Context (requirements) shared by every generated Bunny operation. */
export type BunnyOpContext = Credentials | HttpClient.HttpClient;

const credentials = Effect.gen(function* () {
  const resolve = yield* Credentials;
  return yield* resolve;
});

const unknownError = ({ code, message, body }: RestErrorInfo) =>
  new UnknownBunnyError({
    code: code === undefined ? undefined : String(code),
    message,
    body,
  });

const parseError = ({ body, cause }: RestParseErrorInfo) => new BunnyParseError({ body, cause });

export const BunnyProtocol: Layer.Layer<API.Protocol> =
  makeRestProtocol<Config>({
    credentials,
    baseUrl: (creds) => creds.apiBaseUrl,
    headers: (creds) => ({ AccessKey: Redacted.value(creds.apiKey) }),
    errorEnvelope: (body) => {
      if (body === null || typeof body !== "object") return undefined;
      const b = body as Record<string, unknown>;
      return {
        code: typeof b.ErrorKey === "string" ? b.ErrorKey : undefined,
        message: typeof b.Message === "string" ? b.Message : undefined,
      };
    },
    unknownError,
    parseError,
  });

/** The Bunny Database API: same key, `/database` base path, `{ error }` bodies. */
export const BunnyDatabaseProtocol: Layer.Layer<API.Protocol> =
  makeRestProtocol<Config>({
    credentials,
    baseUrl: (creds) => `${creds.apiBaseUrl}/database`,
    headers: (creds) => ({ AccessKey: Redacted.value(creds.apiKey) }),
    errorEnvelope: (body) => {
      if (body === null || typeof body !== "object") return undefined;
      const b = body as Record<string, unknown>;
      const details = b.details === undefined ? "" : ` ${JSON.stringify(b.details)}`;
      return {
        message: typeof b.error === "string" ? `${b.error}${details}` : undefined,
      };
    },
    unknownError,
    parseError,
  });
