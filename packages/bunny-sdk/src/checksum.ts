import * as crypto from "node:crypto";

/** Uppercase hex SHA-256, the format the storage `Checksum` header and listings use. */
export const checksumOf = (body: Uint8Array): string =>
  crypto.createHash("sha256").update(body).digest("hex").toUpperCase();
