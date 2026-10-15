#!/usr/bin/env bun
/**
 * convert — turn Bunny's OpenAPI documents into Smithy JSON models.
 *
 * Input:  specs/{core,compute,database}.json          (scripts/fetch-specs.ts)
 *         patches/{core,compute,database}/*.patch.json (RFC-6902; OpenAPI
 *           pointers apply before conversion, /shapes pointers after)
 * Output: .generated-specs/{core,compute,database}.json
 *
 * Pipeline per spec: OpenAPI patches → route filter (database only) →
 * operationId rewrite (scripts/operation-names.ts) → convert → Smithy
 * patches.
 * `scripts/generate.ts` compiles the models into src/services.
 */
import * as path from "node:path";
import { runOpenApiConvert } from "@distilled.cloud/core/codegen/openapi-cli";
import {
  COMPUTE_OPERATION_NAMES,
  CORE_OPERATION_NAMES,
  DATABASE_OPERATION_NAMES,
} from "./operation-names.ts";

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

/** Rewrite operationIds from a "METHOD /path" map; fail on stale keys. */
const renameOperations =
  (names: Readonly<Record<string, string>>) => (spec: any) => {
    const seen = new Set<string>();
    for (const [route, item] of Object.entries<any>(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const key = `${method.toUpperCase()} ${route}`;
        const name = names[key];
        if (name === undefined) continue;
        op.operationId = name;
        seen.add(key);
      }
    }
    const stale = Object.keys(names).filter((key) => !seen.has(key));
    if (stale.length > 0) {
      throw new Error(
        `operation-names.ts lists routes the spec no longer has: ${stale.join(", ")}`,
      );
    }
  };

/** Database routes to keep: the v2 database API and the v1 region config. */
const DATABASE_ROUTES = /^\/(v2\/databases|v1\/config)(\/|$)/;

const dropRoutes = (keep: RegExp) => (spec: any) => {
  for (const route of Object.keys(spec.paths)) {
    if (!keep.test(route)) delete spec.paths[route];
  }
};

await runOpenApiConvert({
  root: path.resolve(import.meta.dir, ".."),
  specs: [
    {
      name: "core",
      specPath: "specs/core.json",
      preprocess: renameOperations(CORE_OPERATION_NAMES),
      options: { namespace: "net.bunny.core", serviceName: "BunnyCore" },
    },
    {
      name: "compute",
      specPath: "specs/compute.json",
      preprocess: renameOperations(COMPUTE_OPERATION_NAMES),
      options: { namespace: "net.bunny.compute", serviceName: "BunnyCompute" },
    },
    {
      name: "database",
      specPath: "specs/database.json",
      preprocess: (spec: any) => {
        dropRoutes(DATABASE_ROUTES)(spec);
        renameOperations(DATABASE_OPERATION_NAMES)(spec);
      },
      options: { namespace: "net.bunny.database", serviceName: "BunnyDatabase" },
    },
  ],
  patchesDir: "patches",
  options: {
    namespace: "net.bunny",
    serviceName: "Bunny",
    skipDeprecated: true,
  },
});
