/**
 * Edge Storage file API client — hand-written.
 *
 * Bunny's storage OpenAPI document is incomplete (no operationIds, no
 * `Checksum` on listings, a wrong New York host), so this module talks to
 * the HTTP API directly. Behaviour follows https://bunny.net/docs/storage/http
 * and the official storage SDK (BunnyWay/edge-script-sdk, libs/bunny-storage):
 *
 *   - host: the zone's `StorageHostname` (e.g. `storage.bunnycdn.com`,
 *     `ny.storage.bunnycdn.com`); URL `https://{host}/{zone}/{path}`
 *   - auth: `AccessKey: <storage zone password>` (not the account key)
 *   - upload: PUT raw bytes, `Content-Type: application/octet-stream`,
 *     optional `Override-Content-Type`, optional `Checksum` (uppercase hex
 *     SHA-256, see `checksum.ts`; a mismatch is rejected with 400)
 *   - list: GET `{dir}/` returns one directory level (not recursive), each
 *     entry with `Checksum` (null for directories)
 *   - delete: DELETE; deleting a directory deletes its contents
 *
 * Limits (https://bunny.net/docs/storage/limits): at most 5 concurrent
 * listings and 30 concurrent deletes per zone; exceeding them returns 400
 * "Unable to process request", which this client treats as throttling.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** Where and how to reach one storage zone's files. */
export interface StorageZoneAccess {
  /** `StorageZoneModel.StorageHostname`, e.g. `storage.bunnycdn.com`. */
  readonly hostname: string;
  /** The storage zone name. */
  readonly zoneName: string;
  /** The storage zone password (or read-only password for reads). */
  readonly password: Redacted.Redacted<string>;
  /**
   * Origin to send requests to instead of `https://{hostname}`, e.g. a
   * local test server. Defaults to `https://{hostname}`.
   */
  readonly endpoint?: string;
}

/** One entry of a directory listing. */
export interface StorageObject {
  /** Path relative to the zone root, without a leading slash. */
  readonly key: string;
  readonly isDirectory: boolean;
  readonly length: number;
  /** Uppercase hex SHA-256 of the content; null for directories. */
  readonly checksum: string | null;
  readonly contentType: string | null;
}

export class StorageUnauthorized extends Data.TaggedError(
  "StorageUnauthorized",
)<{ readonly key: string; readonly message: string }> {}

export class StorageNotFound extends Data.TaggedError("StorageNotFound")<{
  readonly key: string;
  readonly message: string;
}> {}

/** Invalid path, or a `Checksum` that does not match the body. */
export class StorageBadRequest extends Data.TaggedError("StorageBadRequest")<{
  readonly key: string;
  readonly message: string;
}> {}

/** 429, or a 400 for exceeding the concurrent listing/delete limits. */
export class StorageThrottled extends Data.TaggedError("StorageThrottled")<{
  readonly key: string;
  readonly message: string;
}> {}

export class StorageServerError extends Data.TaggedError("StorageServerError")<{
  readonly key: string;
  readonly status: number;
  readonly message: string;
}> {}

/** The request never produced a response, or the response was unreadable. */
export class StorageTransportError extends Data.TaggedError(
  "StorageTransportError",
)<{ readonly key: string; readonly message: string; readonly cause?: unknown }> {}

export type StorageError =
  | StorageUnauthorized
  | StorageNotFound
  | StorageBadRequest
  | StorageThrottled
  | StorageServerError
  | StorageTransportError;

// `checksumOf` (the `Checksum` header's format) lives in `checksum.ts`: it
// needs `node:crypto`, which this module avoids so runtime clients bundled
// into a Cloudflare Worker without `nodejs_compat` still load.

const encodeKey = (key: string): string =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const urlFor = (access: StorageZoneAccess, key: string): string =>
  `${access.endpoint ?? `https://${access.hostname}`}/${encodeURIComponent(access.zoneName)}/${encodeKey(key)}`;

const classify = (status: number, key: string, text: string): StorageError => {
  const message = text.trim() || `HTTP ${status}`;
  if (status === 401) return new StorageUnauthorized({ key, message });
  if (status === 404) return new StorageNotFound({ key, message });
  if (status === 429 || (status === 400 && /unable to process request/i.test(text))) {
    return new StorageThrottled({ key, message });
  }
  if (status === 400) return new StorageBadRequest({ key, message });
  return new StorageServerError({ key, status, message });
};

const isTransient = (error: StorageError): boolean =>
  error._tag === "StorageThrottled" ||
  error._tag === "StorageServerError" ||
  error._tag === "StorageTransportError";

/** Retry throttling, 5xx and transport failures with jittered backoff. */
const retryTransient = <A, R>(
  effect: Effect.Effect<A, StorageError, R>,
): Effect.Effect<A, StorageError, R> =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered),
      times: 6,
      while: isTransient,
    }),
  );

const send = (
  access: StorageZoneAccess,
  key: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  StorageError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.setHeader("AccessKey", Redacted.value(access.password)),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new StorageTransportError({ key, message: String(cause), cause }),
        ),
      );
    if (response.status >= 200 && response.status < 300) return response;
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(classify(response.status, key, text));
  });

/** Upload `body` to `key`, creating parent directories as needed. */
export const putObject = (
  access: StorageZoneAccess,
  key: string,
  body: Uint8Array,
  options: { readonly checksum?: string; readonly contentType?: string } = {},
): Effect.Effect<void, StorageError, HttpClient.HttpClient> => {
  const headers: Record<string, string> = {};
  if (options.checksum) headers["Checksum"] = options.checksum;
  if (options.contentType) headers["Override-Content-Type"] = options.contentType;
  const request = HttpClientRequest.put(urlFor(access, key)).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
  );
  return retryTransient(send(access, key, request)).pipe(Effect.asVoid);
};

/** A downloaded file with the metadata bunny.net returns for it. */
export interface StorageFile {
  /** Path relative to the zone root, without a leading slash. */
  readonly key: string;
  readonly body: Uint8Array;
  /** Derived by bunny.net from the extension (or `Override-Content-Type`). */
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

/** Download `key` with its metadata; `undefined` when it does not exist. */
export const getFile = (
  access: StorageZoneAccess,
  key: string,
): Effect.Effect<StorageFile | undefined, StorageError, HttpClient.HttpClient> =>
  retryTransient(
    Effect.gen(function* () {
      const response = yield* send(access, key, HttpClientRequest.get(urlFor(access, key)));
      const buffer = yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) =>
            new StorageTransportError({ key, message: String(cause), cause }),
        ),
      );
      const lastModified = response.headers["last-modified"];
      return {
        key,
        body: new Uint8Array(buffer),
        contentType: response.headers["content-type"] ?? null,
        etag: response.headers["etag"] ?? null,
        lastModified: lastModified ? new Date(lastModified) : null,
      } satisfies StorageFile;
    }),
  ).pipe(Effect.catchTag("StorageNotFound", () => Effect.succeed(undefined)));

/** Download `key`; `undefined` when it does not exist. */
export const getObject = (
  access: StorageZoneAccess,
  key: string,
): Effect.Effect<Uint8Array | undefined, StorageError, HttpClient.HttpClient> =>
  Effect.map(getFile(access, key), (file) => file?.body);

/** Delete a file (or a directory and its contents). Missing is success. */
export const deleteObject = (
  access: StorageZoneAccess,
  key: string,
): Effect.Effect<void, StorageError, HttpClient.HttpClient> =>
  retryTransient(
    send(access, key, HttpClientRequest.make("DELETE")(urlFor(access, key))),
  ).pipe(
    Effect.asVoid,
    Effect.catchTag("StorageNotFound", () => Effect.void),
  );

const ListingEntry = Schema.Struct({
  ObjectName: Schema.String,
  Path: Schema.String,
  IsDirectory: Schema.Boolean,
  Length: Schema.Number,
  Checksum: Schema.optional(Schema.NullOr(Schema.String)),
  ContentType: Schema.optional(Schema.NullOr(Schema.String)),
});
const Listing = Schema.Array(ListingEntry);

/**
 * List one directory level. `dir` is relative to the zone root ("" for the
 * root). A directory that does not exist lists as empty.
 */
export const listDirectory = (
  access: StorageZoneAccess,
  dir: string,
): Effect.Effect<readonly StorageObject[], StorageError, HttpClient.HttpClient> => {
  const prefix = dir === "" || dir.endsWith("/") ? dir : `${dir}/`;
  return retryTransient(
    Effect.gen(function* () {
      const response = yield* send(
        access,
        prefix,
        HttpClientRequest.get(urlFor(access, prefix)).pipe(
          HttpClientRequest.acceptJson,
        ),
      );
      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new StorageTransportError({ key: prefix, message: String(cause), cause }),
        ),
      );
      const entries = yield* Schema.decodeUnknownEffect(Listing)(json).pipe(
        Effect.mapError(
          (cause) =>
            new StorageTransportError({
              key: prefix,
              message: `unexpected listing shape: ${String(cause)}`,
              cause,
            }),
        ),
      );
      return entries.map(
        (entry): StorageObject => ({
          key: `${prefix}${entry.ObjectName}${entry.IsDirectory ? "/" : ""}`,
          isDirectory: entry.IsDirectory,
          length: entry.Length,
          checksum: entry.Checksum ?? null,
          contentType: entry.ContentType ?? null,
        }),
      );
    }),
  ).pipe(Effect.catchTag("StorageNotFound", () => Effect.succeed([])));
};

/**
 * List every file under `prefix` (recursively). Directories are walked
 * level by level with at most `concurrency` listings in flight; Bunny allows
 * 5 per zone.
 */
export const listFiles = (
  access: StorageZoneAccess,
  prefix = "",
  options: { readonly concurrency?: number } = {},
): Effect.Effect<readonly StorageObject[], StorageError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const concurrency = Math.min(options.concurrency ?? 4, 5);
    const files: StorageObject[] = [];
    let level: readonly string[] = [prefix];
    while (level.length > 0) {
      const listings = yield* Effect.forEach(
        level,
        (dir) => listDirectory(access, dir),
        { concurrency },
      );
      const next: string[] = [];
      for (const entries of listings) {
        for (const entry of entries) {
          if (entry.isDirectory) next.push(entry.key);
          else files.push(entry);
        }
      }
      level = next;
    }
    return files;
  });
