/**
 * `alchemy-bunny/EdgeScriptFetch` — calling one Edge Script from
 * another with the semantics of a Cloudflare service binding: the callee
 * handles the request as the URL the caller passed (its origin, path and
 * query), not as its own `*.bunny.run` URL.
 *
 * bunny.net has no service bindings, so the call goes over HTTPS to the
 * callee's URL and carries the original URL plus a shared key. An
 * Effect-native callee (`Bunny.EdgeScript` class) re-addresses a request
 * with the right key before its handler sees it and strips both headers
 * from every request, so the original URL cannot be spoofed without the key.
 *
 * The key is an `Alchemy.Random` per callee, bound onto the callee as
 * `ALCHEMY_FETCH_KEY` by whatever binds a caller to it: the
 * `Bunny.FetchEdgeScript` capability (Effect-native callers) or an
 * `EdgeScript` value in an `env` map (non-Effect callers, read with
 * {@link edgeScriptFetcher}).
 *
 * This module imports nothing (no Alchemy, no Effect), so it is safe to
 * bundle into any runtime.
 */

/** The original URL the caller addressed. */
export const FORWARDED_URL_HEADER = "x-alchemy-forwarded-url";
/** The callee's key; a forwarded URL is honoured only with it. */
export const FETCH_KEY_HEADER = "x-alchemy-fetch-key";
/** The callee's env var holding its key. */
export const FETCH_KEY_ENV = "ALCHEMY_FETCH_KEY";

/** The env var names an `EdgeScript` value in an `env` map expands to. */
export const edgeScriptEnvNames = (name: string) => ({ url: `${name}_URL`, key: `${name}_KEY` });

/** The logical ID of a callee's key (`Alchemy.Random`), shared by every caller. */
export const fetchKeyLogicalId = (callee: { readonly LogicalId: string }) => `${callee.LogicalId}FetchKey`;

type FetchInput = Request | string | URL;

const hasBody = (method: string) => method !== "GET" && method !== "HEAD";

/**
 * Address `input` to the callee at `baseUrl`, carrying the original URL and
 * `key`. A relative URL resolves against the callee. Redirects are not
 * followed: the caller gets the callee's response as-is.
 */
export const toForwardedRequest = (
  input: FetchInput,
  init: RequestInit | undefined,
  target: { readonly url: string; readonly key: string },
): Request => {
  const request =
    input instanceof Request
      ? init === undefined
        ? input
        : new Request(input, init)
      : new Request(new URL(String(input), target.url).href, init);
  const original = new URL(request.url);
  const callee = new URL(`${original.pathname}${original.search}`, target.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set(FORWARDED_URL_HEADER, original.href);
  headers.set(FETCH_KEY_HEADER, target.key);
  const body = hasBody(request.method) ? request.body : null;
  return new Request(callee.href, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
};

/** Compare without an early exit on the first differing character. */
const sameKey = (a: string, b: string): boolean => {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Callee side: a request carrying the callee's key is re-addressed to the
 * forwarded URL; every request loses both headers. Returns `request`
 * unchanged when it carries neither.
 */
export const fromForwardedRequest = (request: Request, expectedKey: string | undefined): Request => {
  const forwarded = request.headers.get(FORWARDED_URL_HEADER);
  const key = request.headers.get(FETCH_KEY_HEADER);
  if (forwarded === null && key === null) return request;
  const headers = new Headers(request.headers);
  headers.delete(FORWARDED_URL_HEADER);
  headers.delete(FETCH_KEY_HEADER);
  let url = request.url;
  if (forwarded !== null && key !== null && expectedKey !== undefined && sameKey(key, expectedKey)) {
    try {
      url = new URL(forwarded).href;
    } catch {
      // Malformed: handle the request at its own URL.
    }
  }
  const body = hasBody(request.method) ? request.body : null;
  return new Request(url, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    signal: request.signal,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
};

/** The `fetch` of a bound Edge Script, like a Cloudflare service binding's `Fetcher`. */
export interface EdgeScriptFetcher {
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
}

/**
 * For non-Effect code (a framework server, a plain Edge Script): the fetcher
 * of an Edge Script bound in the host's `env` map as `name`, e.g.
 * `env: { AUTH_API: authApi }` → `edgeScriptFetcher("AUTH_API")`. Reads
 * `<name>_URL` and `<name>_KEY` from `env` (default `process.env`) on each
 * call.
 *
 * ```typescript
 * const auth = edgeScriptFetcher("AUTH_API");
 * const response = await auth.fetch(request); // handled as request.url
 * ```
 */
export const edgeScriptFetcher = (
  name: string,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): EdgeScriptFetcher => {
  const names = edgeScriptEnvNames(name);
  return {
    fetch: (input, init) => {
      const url = env[names.url];
      const key = env[names.key];
      if (!url || !key) {
        return Promise.reject(new Error(`Edge Script binding ${name} is missing ${names.url} or ${names.key}`));
      }
      return fetch(toForwardedRequest(input, init, { url, key }));
    },
  };
};
