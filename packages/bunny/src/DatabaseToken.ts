import { Database as DatabaseApi, Retry } from "alchemy-bunny-sdk";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { toRedacted } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export type DatabaseTokenAuthorization = "full-access" | "read-only";

export interface DatabaseTokenProps {
  /** The database the token opens (a `Bunny.Database`). */
  database: { readonly databaseId: string };
  /**
   * `read-only` tokens are rejected (403) on writes. Changing it issues a
   * new token.
   * @default "full-access"
   */
  authorization?: DatabaseTokenAuthorization;
  /**
   * RFC 3339 expiry, e.g. `"2027-01-01T00:00:00Z"`. Without one the token
   * never expires. Changing it issues a new token.
   */
  expiresAt?: string;
}

export interface DatabaseTokenAttributes {
  databaseId: string;
  authorization: DatabaseTokenAuthorization;
  expiresAt: string | undefined;
  /** The JWT — the `BUNNY_DATABASE_AUTH_TOKEN`. */
  token: Redacted.Redacted<string>;
}

export type DatabaseToken = Resource<
  "Bunny.DatabaseToken",
  DatabaseTokenProps,
  DatabaseTokenAttributes,
  never,
  Providers
>;

/**
 * An auth token (JWT) for a `Bunny.Database`, sent by clients as
 * `Authorization: Bearer <token>`.
 *
 * **Revocation.** bunny.net revokes all of a database's tokens at once, or
 * none:
 *
 * - Destroying or replacing this resource does not revoke its token; the
 *   old JWT stays valid until it expires or all tokens are revoked
 *   (dashboard, `bunny db tokens invalidate`, or the SDK's
 *   `Database.revokeDatabaseTokens`). Set `expiresAt` on tokens you intend
 *   to rotate.
 * - After a revoke-all, Alchemy cannot tell: the API does not report
 *   revoked tokens, so every `DatabaseToken` of that database (including
 *   the ones `QueryDatabaseHttp` and `BunnyDatabase` issue) keeps its dead
 *   value in state and deploys as a no-op. To reissue them, delete their
 *   state records (`alchemy state delete <stack>/<stage>/<LogicalId>`; the
 *   resource's delete calls nothing) and deploy again, which issues new
 *   tokens and re-binds them into their hosts.
 *
 * See docs/database.md in the repository.
 *
 * @example
 * ```typescript
 * const db = yield* Bunny.Database("Db", {});
 * const token = yield* Bunny.DatabaseToken("DbToken", { database: db });
 * const readOnly = yield* Bunny.DatabaseToken("Reports", {
 *   database: db,
 *   authorization: "read-only",
 * });
 * ```
 *
 * @resource
 */
export const DatabaseToken = Resource<DatabaseToken>("Bunny.DatabaseToken");

/** The token's database does not exist. */
export class DatabaseMissing extends Data.TaggedError("DatabaseMissing")<{
  readonly databaseId: string;
}> {}

const desiredOf = (news: DatabaseTokenProps) => ({
  databaseId: news.database.databaseId,
  authorization: news.authorization ?? "full-access",
  expiresAt: news.expiresAt,
});

const databaseExists = (databaseId: string) =>
  DatabaseApi.getDatabase({ db_id: databaseId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const DatabaseTokenProvider = () =>
  Provider.succeed(DatabaseToken, {
    stables: ["databaseId", "authorization", "expiresAt", "token"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      const desired = desiredOf(news);
      // A token cannot be changed; any difference means a new one.
      if (
        desired.databaseId !== output.databaseId ||
        desired.authorization !== output.authorization ||
        desired.expiresAt !== output.expiresAt
      ) {
        return { action: "replace" } as const;
      }
      // Other changes to the database's attributes do not affect the token.
      return { action: "noop" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      // Tokens cannot be read back; the token lives as long as its database
      // (or until revoked, which the API cannot report).
      if (output === undefined) return undefined;
      return (yield* databaseExists(output.databaseId)) ? output : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      const desired = desiredOf(news);
      if (
        output !== undefined &&
        output.databaseId === desired.databaseId &&
        output.authorization === desired.authorization &&
        output.expiresAt === desired.expiresAt &&
        (yield* databaseExists(output.databaseId))
      ) {
        return output;
      }
      if (!(yield* databaseExists(desired.databaseId))) {
        return yield* new DatabaseMissing({ databaseId: desired.databaseId });
      }
      // Only throttling is retried: a token minted twice after a lost
      // response is a valid token nobody holds.
      const generated = yield* DatabaseApi.generateDatabaseToken({
        db_id: desired.databaseId,
        authorization: desired.authorization,
        expires_at: desired.expiresAt,
      }).pipe(Retry.throttling);
      yield* session.note(`Issued ${desired.authorization} token for ${desired.databaseId}`);
      return {
        databaseId: desired.databaseId,
        authorization: desired.authorization,
        expiresAt: generated.expires_at ?? desired.expiresAt,
        token: toRedacted(generated.token),
      };
    }),
    // Nothing to call: bunny.net revokes all of a database's tokens or none.
    delete: () => Effect.void,
  });
