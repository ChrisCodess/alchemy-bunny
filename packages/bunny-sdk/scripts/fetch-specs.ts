#!/usr/bin/env bun
/**
 * fetch-specs — download Bunny's published OpenAPI documents into specs/.
 *
 * Sources are the URLs the official `@bunny.net/openapi-client` uses
 * (https://bunny.net/docs/openapi). The core document at
 * core-api-public-docs.b-cdn.net is newer than the copy under
 * bunny.net/docs/api-reference/core and is the one to track. The database
 * document is served by the Bunny Database API itself.
 *
 * Output is written with sorted keys so a re-fetch only diffs on real
 * upstream changes. Run `bun run convert && bun run generate` afterwards.
 */
import * as path from "node:path";

const SPECS: Record<string, string> = {
  core: "https://core-api-public-docs.b-cdn.net/docs/v3/public.json",
  compute: "https://core-api-public-docs.b-cdn.net/docs/v3/compute.json",
  database: "https://api.bunny.net/database/docs/private/api.json",
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

for (const [name, url] of Object.entries(SPECS)) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name}: ${url} returned ${response.status}`);
  }
  const spec = (await response.json()) as Record<string, unknown>;
  if (typeof spec.openapi !== "string" || typeof spec.paths !== "object") {
    throw new Error(`${name}: ${url} is not an OpenAPI 3 document`);
  }
  const out = path.resolve(import.meta.dir, "..", "specs", `${name}.json`);
  await Bun.write(out, JSON.stringify(sortKeys(spec), null, 2) + "\n");
  console.log(
    `${name}: ${Object.keys(spec.paths as object).length} paths -> ${path.relative(process.cwd(), out)}`,
  );
}
