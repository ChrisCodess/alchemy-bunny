#!/usr/bin/env bun
/**
 * generate — compile the Smithy models in .generated-specs into the Bunny
 * Effect SDK.
 *
 * Input:  .generated-specs/{core,compute,database}.json  (scripts/convert.ts)
 * Output: src/services/{core,compute,database}.ts + src/services/index.ts
 *
 * Bunny's wire member names (PascalCase: `Name`, `StorageZoneId`; snake_case
 * in the database API: `db_id`) are kept on the TypeScript surface. The
 * database module uses `BunnyDatabaseProtocol` (its own base path and error
 * body).
 */
import type { SdkSpec } from "@distilled.cloud/core/codegen/generator";
import { runGeneratorCli } from "@distilled.cloud/core/codegen/cli";
import {
  JSON_PRELUDE,
  TS_JSON_PRELUDE,
} from "@distilled.cloud/core/codegen/prelude";

const NULLABLE_TRAIT = "com.distilled.openapi#nullable";
const ERROR_MATCHERS_TRAIT = "com.distilled.openapi#errorMatchers";
const RAW_RESPONSE_TRAIT = "com.distilled.openapi#rawResponse";
const SENSITIVE_TRAIT = "smithy.api#sensitive";

const bunnySpec: SdkSpec = {
  nullableTrait: NULLABLE_TRAIT,
  errorMatchersTrait: ERROR_MATCHERS_TRAIT,
  prelude: {
    ...JSON_PRELUDE,
    Blob: "S.Union([S.instanceOf(Blob), S.instanceOf(Uint8Array), S.instanceOf(ArrayBuffer)])",
  },
  tsPrelude: {
    ...TS_JSON_PRELUDE,
    Blob: "Blob | Uint8Array | ArrayBuffer",
  },

  extraBindings: [
    {
      // Sole member of a synthesized wrapper for bare array/scalar response
      // bodies; as the response's only member, the response IS the payload.
      trait: RAW_RESPONSE_TRAIT,
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],

  // Sensitive strings (storage zone passwords, keys): the REST protocol
  // delivers Redacted values and accepts string | Redacted on input.
  memberTraitPipes: {
    [SENSITIVE_TRAIT]: "T.SensitiveValue",
  },
  memberTsType: (m) =>
    SENSITIVE_TRAIT in m.traits
      ? `string | Redacted.Redacted<string>${m.nullable ? " | null" : ""}`
      : undefined,

  // GET /pullzone answers with a plain array or a page envelope
  // (patches/core/002); decode whichever arrives.
  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = /*@__PURE__*/ S.suspend(() => S.Union([${caseTargets.map(tsRef).join(", ")}])) as any as S.Schema<${name}>;\n`,
  ],

  // Paged lists: { Items, CurrentPage, TotalItems, HasMoreItems }.
  paginationProfiles: {
    page: {
      strategy: "paginateHasMore",
      itemsFallback: "Items",
    },
  },

  operationDecl: {
    contextType: "BunnyOpContext",
    commonErrorType: "BunnyOpError",
    commonErrorClasses: ["UnknownBunnyError"],
    protocol: "BunnyProtocol",
    retry: "Retry.Retry",
  },

  sourceNote: ".generated-specs (specs/{core,compute,database}.json)",

  // Sensitive member types reference Redacted; pull the import in when used.
  postProcess: (code) =>
    code.includes("Redacted.Redacted<")
      ? code.replace(
          `import * as S from "@distilled.cloud/core/schema";\n`,
          `import * as S from "@distilled.cloud/core/schema";\nimport * as Redacted from "effect/Redacted";\n`,
        )
      : code,
};

const isDatabaseModel = (model: any) =>
  Object.keys(model.shapes ?? {}).some((id) => id.startsWith("net.bunny.database#"));

const databaseSpec: SdkSpec = {
  ...bunnySpec,
  operationDecl: { ...bunnySpec.operationDecl!, protocol: "BunnyDatabaseProtocol" },
};

runGeneratorCli({
  description: "Generate the Bunny Effect SDK from the Smithy models",
  root: `${import.meta.dir}/..`,
  // patches/ holds RFC-6902 patches consumed by scripts/convert.ts.
  patchesDir: false,
  spec: (model) => (isDatabaseModel(model) ? databaseSpec : bunnySpec),
});
