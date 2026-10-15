/**
 * Bunny error types.
 *
 * Re-exports the shared HTTP errors from core and adds the Bunny fallback.
 * The generated service modules define their own per-status classes
 * (BadRequest/NotFound/NameTaken/…) for the statuses each operation
 * declares; they share `_tag`s with the core classes, so `catchTag` works
 * against either.
 */
export {
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  Forbidden,
  GatewayTimeout,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  HTTP_STATUS_MAP,
  DEFAULT_ERRORS,
  API_ERRORS,
} from "@distilled.cloud/core/errors";
export type { DefaultErrors } from "@distilled.cloud/core/errors";

import * as Schema from "effect/Schema";
import * as Category from "@distilled.cloud/core/category";

/** Returned when no typed error matches the failure. */
export class UnknownBunnyError extends Schema.TaggedError<UnknownBunnyError>()(
  "UnknownBunnyError",
  {
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}
