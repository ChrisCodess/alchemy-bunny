import * as Bunny from "alchemy-bunny";

/**
 * The app's Bunny Database: the guestbook (migrations/*.sql) and Better
 * Auth's tables (migrated at deploy by `BetterAuth()` in `auth/api.ts`).
 */
export const Db = Bunny.Database("Db", { migrations: "./migrations" });
