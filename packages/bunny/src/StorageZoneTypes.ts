/**
 * Types shared by the storage zone capabilities (`ReadStorageZone`,
 * `WriteStorageZone`, `ReadWriteStorageZone`) — the Edge Storage client's
 * own types, like `Cloudflare.R2`'s `BucketTypes.ts`.
 */
export type {
  StorageError,
  StorageFile,
  StorageObject,
} from "alchemy-bunny-sdk/storage";
export {
  StorageBadRequest,
  StorageNotFound,
  StorageServerError,
  StorageThrottled,
  StorageTransportError,
  StorageUnauthorized,
} from "alchemy-bunny-sdk/storage";

/** Options of `WriteStorageZoneClient.put`. */
export interface PutOptions {
  /**
   * `Content-Type` bunny.net serves the file with. By default bunny.net
   * derives it from the file extension.
   */
  contentType?: string;
}
