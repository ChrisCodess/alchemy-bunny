import { connect } from "@bunny.net/database-client";

export interface Message {
  id: number;
  name: string;
  body: string;
  created_at: string;
}

/**
 * `connect()` reads BUNNY_DATABASE_URL and BUNNY_DATABASE_AUTH_TOKEN, which
 * `Bunny.Website.TanStackStart({ database })` sets on the Edge Script.
 * Each query is one HTTPS request; there is no connection to keep.
 */
export const db = () => connect({ timeout: 10_000 });
