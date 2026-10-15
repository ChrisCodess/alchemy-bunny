import { edgeScriptFetcher } from "alchemy-bunny/EdgeScriptFetch";

/**
 * The Better Auth Edge Script, bound in the site's `env` as `AUTH_API`
 * (`alchemy.run.ts`). Like a Cloudflare service binding, it handles each
 * request as the URL it is addressed to — the site's own.
 */
const authApi = edgeScriptFetcher("AUTH_API");

/** Forward a request (`/api/auth/*`) to the auth script. */
export const forwardToAuth = (request: Request): Promise<Response> => authApi.fetch(request);

export interface SessionUser {
  name: string;
  email: string;
}

/** The signed-in user for `request`'s cookies, asked of the auth script. */
export const getSessionUser = async (request: Request): Promise<SessionUser | null> => {
  // Only the cookies: the caller may be a POST server function, whose body
  // headers do not belong on this GET.
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const response = await authApi.fetch(new Request(new URL("/api/auth/get-session", request.url).href, { headers }));
  if (!response.ok) return null;
  const session = (await response.json()) as { user?: SessionUser } | null;
  return session?.user ? { name: session.user.name, email: session.user.email } : null;
};
