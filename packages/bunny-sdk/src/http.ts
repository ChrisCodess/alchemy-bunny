/**
 * An `HttpClient` that keeps the `AccessKey` header out of error values.
 *
 * bunny.net authenticates with `AccessKey`: the account key on the
 * management APIs, a zone password on Edge Storage. Effect redacts
 * `authorization` and a few other headers when an `HttpClientError` is
 * inspected or serialised, but not `accesskey`, so a logged error would print
 * the credential. Setting the header as a `Redacted` value is no fix: it goes
 * on the wire as the placeholder. So every error that leaves the client gets
 * a copy of its request with the header replaced.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** The header bunny.net reads credentials from. */
export const ACCESS_KEY_HEADER = "AccessKey";

const REDACTED = "<redacted>";

/** `error`, with the `AccessKey` header of its request replaced by a placeholder. */
export const redactAccessKeyError = (
  error: HttpClientError.HttpClientError,
): HttpClientError.HttpClientError => {
  const reason = error.reason;
  if (!("accesskey" in reason.request.headers)) return error;
  const request = HttpClientRequest.setHeader(reason.request, ACCESS_KEY_HEADER, REDACTED);
  // Rebuild the reason around the scrubbed request. Its tag, fields and
  // cause are own properties, so the typed error keeps its shape.
  const Reason = reason.constructor as new (props: object) => HttpClientError.HttpClientErrorReason;
  return new HttpClientError.HttpClientError({ reason: new Reason({ ...reason, request }) });
};

/** Wrap a client so that no error it fails with carries an `AccessKey` value. */
export const redactAccessKey = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(client, (effect) => Effect.mapError(effect, redactAccessKeyError));

/** `FetchHttpClient.layer` with the `AccessKey` header redacted in errors. */
export const RedactingFetchHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, redactAccessKey),
).pipe(Layer.provide(FetchHttpClient.layer));
