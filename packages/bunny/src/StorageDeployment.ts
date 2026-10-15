import { checksumOf, Storage } from "alchemy-bunny-sdk";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { initialCwd } from "alchemy/Util/Node";
import { contentTypeOf } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import { resolveStorageAccess } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export interface StorageFileOption {
  /** Glob or globs (relative to `sourcePath`) the option applies to. */
  files: string | string[];
  /** Content type to serve matched files with. */
  contentType?: string;
}

export interface StorageDeploymentProps {
  /** Destination storage zone (pass the `StorageZone` resource). */
  storageZone: { readonly storageZoneId: number };
  /** Local directory to upload, relative to the directory Alchemy runs in. */
  sourcePath: string;
  /** Key prefix inside the zone. Default: the zone root. */
  prefix?: string;
  /**
   * Delete files under `prefix` that are not in `sourcePath`, and delete the
   * uploaded files when this resource is deleted.
   * @default false
   */
  purge?: boolean;
  /** Per-file overrides; the last matching option wins. */
  fileOptions?: StorageFileOption[];
}

export interface StorageDeploymentAttributes {
  storageZoneId: number;
  /** Normalised key prefix ("" for the zone root). */
  prefix: string;
  /**
   * Hash of the file set (paths, contents, content types). It changes only
   * when a file changes, so it works as a cache purge token.
   */
  version: string;
  /** Number of files in the deployment. */
  fileCount: number;
  /** Paths of the deployed files relative to `sourcePath`, sorted. */
  files: string[];
}

export type StorageDeployment = Resource<
  "Bunny.StorageDeployment",
  StorageDeploymentProps,
  StorageDeploymentAttributes,
  never,
  Providers
>;

/**
 * Sync a local directory into a storage zone.
 *
 * Only files whose SHA-256 differs from the zone's copy are uploaded (with a
 * `Checksum` header, so bunny.net rejects a corrupted upload). HTML files go
 * last, so new pages never reference assets that are not there yet. With
 * `purge`, stale files are deleted after the upload.
 *
 * `diff` hashes `sourcePath` at plan time, so an unchanged directory plans as
 * no-op and a changed file plans as an update, with or without a build step.
 * @see https://bunny.net/docs/storage/http
 *
 * @example
 * ```typescript
 * const files = yield* Bunny.StorageDeployment("Files", {
 *   storageZone: zone,
 *   sourcePath: "dist",
 *   purge: true,
 * });
 * ```
 *
 * @resource
 */
export const StorageDeployment = Resource<StorageDeployment>(
  "Bunny.StorageDeployment",
);

interface ManifestFile {
  readonly relative: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly checksum: string;
  readonly contentType: string;
}

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const toPosix = (value: string) => value.replaceAll("\\", "/");

const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

/**
 * A glob relative to `sourcePath` as a RegExp: `**` matches across
 * directories (a leading `**\/` also matches no directory at all), `*`
 * matches within one path segment, `?` matches one character.
 */
const globToRegExp = (glob: string) =>
  new RegExp(
    `^${escapeRegex(toPosix(glob))
      .replace(/\\\*\\\*\//g, "(?:.*/)?")
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, ".")}$`,
  );

const contentTypeFor = (relative: string, options: StorageFileOption[] | undefined) => {
  const matched = [...(options ?? [])]
    .reverse()
    .find((option) =>
      (Array.isArray(option.files) ? option.files : [option.files]).some((glob) =>
        globToRegExp(glob).test(relative),
      ),
    );
  return matched?.contentType ?? contentTypeOf(relative);
};

const isHtml = (relative: string) => /\.html?$/i.test(relative);

const walkFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(root))) return [] as string[];
  const names = yield* fs.readDirectory(root, { recursive: true });
  const files = yield* Effect.forEach(
    names,
    (name) =>
      fs
        .stat(path.join(root, name))
        .pipe(Effect.map((stat) => (stat.type === "File" ? toPosix(name) : undefined))),
    { concurrency: 32 },
  );
  return files
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => a.localeCompare(b));
});

/** Read, hash and classify every file under `sourcePath`. */
const buildManifest = Effect.fn(function* (props: StorageDeploymentProps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(initialCwd, props.sourcePath);
  const prefix = normalizePrefix(props.prefix);
  const relatives = yield* walkFiles(root);
  const files = yield* Effect.forEach(
    relatives,
    (relative) =>
      fs.readFile(path.join(root, relative)).pipe(
        Effect.map(
          (body): ManifestFile => ({
            relative,
            key: prefix ? `${prefix}/${relative}` : relative,
            body,
            checksum: checksumOf(body),
            contentType: contentTypeFor(relative, props.fileOptions),
          }),
        ),
      ),
    { concurrency: 16 },
  );
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const file of files) {
    hash.update("\0");
    hash.update(file.relative);
    hash.update("\0");
    hash.update(file.checksum);
    hash.update("\0");
    hash.update(file.contentType);
  }
  return { prefix, files, version: hash.digest("hex") };
});

/** New zone credentials refuse writes for a few seconds after creation. */
const retryWhileUnauthorized = <A, R>(
  effect: Effect.Effect<A, Storage.StorageError, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "StorageUnauthorized",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const StorageDeploymentProvider = () =>
  Provider.succeed(StorageDeployment, {
    stables: ["storageZoneId", "prefix"],
    // Non-listable: a deployment is an action on a zone, not a standing
    // cloud resource.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (
        news.storageZone.storageZoneId !== output.storageZoneId ||
        normalizePrefix(news.prefix) !== output.prefix ||
        (news.purge ?? false) !== (olds.purge ?? false)
      ) {
        return { action: "update" } as const;
      }
      const manifest = yield* buildManifest(news);
      return manifest.version === output.version
        ? ({ action: "noop" } as const)
        : ({ action: "update" } as const);
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const storageZoneId = news.storageZone.storageZoneId;
      const manifest = yield* buildManifest(news);
      const access = yield* resolveStorageAccess(storageZoneId);

      // Observe what the zone holds under the prefix.
      const remote = yield* retryWhileUnauthorized(
        Storage.listFiles(access, manifest.prefix ? `${manifest.prefix}/` : ""),
      );
      const remoteChecksums = new Map(remote.map((file) => [file.key, file.checksum]));

      // Upload changed files: assets first, HTML last.
      const changed = manifest.files.filter(
        (file) => remoteChecksums.get(file.key) !== file.checksum,
      );
      const upload = (file: ManifestFile) =>
        Storage.putObject(access, file.key, file.body, {
          checksum: file.checksum,
          contentType: file.contentType,
        });
      yield* retryWhileUnauthorized(
        Effect.forEach(
          changed.filter((file) => !isHtml(file.relative)),
          upload,
          { concurrency: 16, discard: true },
        ),
      );
      yield* Effect.forEach(
        changed.filter((file) => isHtml(file.relative)),
        upload,
        { concurrency: 16, discard: true },
      );

      // Delete files that are no longer part of the deployment.
      let deleted = 0;
      if (news.purge ?? false) {
        const desired = new Set(manifest.files.map((file) => file.key));
        const stale = remote.filter((file) => !desired.has(file.key));
        yield* Effect.forEach(stale, (file) => Storage.deleteObject(access, file.key), {
          concurrency: 16,
          discard: true,
        });
        deleted = stale.length;
      }

      yield* session.note(
        `${changed.length} uploaded, ${manifest.files.length - changed.length} unchanged` +
          (news.purge ?? false ? `, ${deleted} deleted` : "") +
          ` (${access.zoneName})`,
      );
      return {
        storageZoneId,
        prefix: manifest.prefix,
        version: manifest.version,
        fileCount: manifest.files.length,
        files: manifest.files.map((file) => file.relative),
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      if (!(olds.purge ?? false)) return;
      yield* Effect.gen(function* () {
        const access = yield* resolveStorageAccess(output.storageZoneId);
        const remote = yield* Storage.listFiles(
          access,
          output.prefix ? `${output.prefix}/` : "",
        );
        yield* Effect.forEach(remote, (file) => Storage.deleteObject(access, file.key), {
          concurrency: 16,
          discard: true,
        });
      }).pipe(Effect.catchTag("StorageZoneMissing", () => Effect.void));
    }),
  });
