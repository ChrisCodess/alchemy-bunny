import { Core } from "alchemy-bunny-sdk";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { withPullZoneLock } from "./internal.ts";
import type { Providers } from "./Providers.ts";

export type EdgeRuleAction =
  /** Serve matching files as downloads (`Content-Disposition: attachment`). */
  | { readonly type: "ForceDownload" }
  /** Reject matching requests. */
  | { readonly type: "BlockRequest" }
  /** Browser cache TTL for matching responses. */
  | { readonly type: "OverrideBrowserCacheTime"; readonly seconds: number }
  /** Edge cache TTL for matching responses (0 bypasses the edge cache). */
  | { readonly type: "OverrideCacheTime"; readonly seconds: number }
  | { readonly type: "SetResponseHeader"; readonly name: string; readonly value: string }
  | { readonly type: "SetRequestHeader"; readonly name: string; readonly value: string }
  /**
   * Serve matching requests from a storage zone (pass the `StorageZone`
   * resource) instead of the pull zone's origin; the request path is
   * appended to `pathPrefix` inside the zone. The official Bunny CLI routes
   * its sites with this action.
   */
  | {
      readonly type: "OriginStorage";
      readonly storageZone: { readonly storageZoneId: number; readonly name: string };
      /** Path inside the zone, with leading and trailing slash. @default "/" */
      readonly pathPrefix?: string;
    }
  /**
   * Any other bunny.net action by its `EdgeRuleActionType` number and raw
   * parameters (e.g. Redirect = 1).
   */
  | {
      readonly type: "Raw";
      readonly actionType: number;
      readonly parameter1?: string;
      readonly parameter2?: string;
      readonly parameter3?: string;
    };

export interface EdgeRuleConditions {
  /**
   * Request URL patterns, matched against the full URL with `*` wildcards,
   * e.g. `"*\/downloads/*"`. At most 5.
   */
  readonly url?: string | readonly string[];
  /** File extensions without the dot, e.g. `["pdf", "zip"]`. At most 5. */
  readonly extension?: string | readonly string[];
}

export interface EdgeRuleProps {
  /** Pull zone the rule belongs to (pass the `PullZone` resource). */
  pullZone: { readonly pullZoneId: number };
  action: EdgeRuleAction;
  /** When the rule applies. With several conditions, any one matching is enough. */
  when: EdgeRuleConditions;
  /**
   * Rule description. It identifies the rule inside its pull zone, so keep
   * it unique. @default `alchemy:<fqn>`
   */
  description?: string;
  /** @default true */
  enabled?: boolean;
  /** Evaluation order; rules without one run in creation order. */
  orderIndex?: number;
}

export interface EdgeRuleAttributes {
  pullZoneId: number;
  /** Rule id inside the pull zone. */
  guid: string;
  description: string;
}

export type EdgeRule = Resource<
  "Bunny.EdgeRule",
  EdgeRuleProps,
  EdgeRuleAttributes,
  never,
  Providers
>;

/**
 * A bunny.net edge rule on a pull zone: an action applied to requests that
 * match URL patterns or file extensions.
 * @see https://bunny.net/docs/cdn/edge-rules
 *
 * @example
 * ```typescript
 * yield* Bunny.EdgeRule("Downloads", {
 *   pullZone: cdn,
 *   action: { type: "ForceDownload" },
 *   when: { url: "*\/downloads/*" },
 * });
 * yield* Bunny.EdgeRule("AssetCache", {
 *   pullZone: cdn,
 *   action: { type: "OverrideBrowserCacheTime", seconds: 86400 },
 *   when: { extension: ["css", "js", "woff2", "svg", "png"] },
 * });
 * ```
 *
 * @resource
 */
export const EdgeRule = Resource<EdgeRule>("Bunny.EdgeRule");

/** bunny.net caps a condition at 5 patterns. */
export class EdgeRuleTooManyPatterns extends Data.TaggedError("EdgeRuleTooManyPatterns")<{
  readonly message: string;
}> {}

const MAX_PATTERNS = 5;
const TRIGGER_URL = 0;
const TRIGGER_URL_EXTENSION = 3;
const MATCH_ANY = 0;

const list = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === "string" ? [value] : [...value];

const actionFields = (action: EdgeRuleAction) => {
  switch (action.type) {
    case "ForceDownload":
      return { ActionType: 7 };
    case "BlockRequest":
      return { ActionType: 4 };
    case "OverrideBrowserCacheTime":
      return { ActionType: 16, ActionParameter1: String(action.seconds) };
    case "OverrideCacheTime":
      return { ActionType: 3, ActionParameter1: String(action.seconds) };
    case "SetResponseHeader":
      return { ActionType: 5, ActionParameter1: action.name, ActionParameter2: action.value };
    case "SetRequestHeader":
      return { ActionType: 6, ActionParameter1: action.name, ActionParameter2: action.value };
    case "OriginStorage":
      return {
        ActionType: 17,
        ActionParameter1: String(action.storageZone.storageZoneId),
        ActionParameter2: action.storageZone.name,
        ActionParameter3: action.pathPrefix ?? "/",
      };
    case "Raw":
      return {
        ActionType: action.actionType,
        ...(action.parameter1 !== undefined ? { ActionParameter1: action.parameter1 } : {}),
        ...(action.parameter2 !== undefined ? { ActionParameter2: action.parameter2 } : {}),
        ...(action.parameter3 !== undefined ? { ActionParameter3: action.parameter3 } : {}),
      };
  }
};

/** The rule as the API's fields (without `Guid`). */
const desiredRule = (news: EdgeRuleProps, description: string) =>
  Effect.gen(function* () {
    const urls = list(news.when.url);
    const extensions = list(news.when.extension).map((ext) => ext.replace(/^\./, ""));
    if (urls.length > MAX_PATTERNS || extensions.length > MAX_PATTERNS) {
      return yield* new EdgeRuleTooManyPatterns({
        message: `Edge rule "${description}": bunny.net allows at most ${MAX_PATTERNS} patterns per condition; split the rule.`,
      });
    }
    const triggers = [
      ...(urls.length
        ? [{ Type: TRIGGER_URL, PatternMatches: urls, PatternMatchingType: MATCH_ANY }]
        : []),
      ...(extensions.length
        ? [{ Type: TRIGGER_URL_EXTENSION, PatternMatches: extensions, PatternMatchingType: MATCH_ANY }]
        : []),
    ];
    return {
      ...actionFields(news.action),
      Triggers: triggers,
      TriggerMatchingType: MATCH_ANY,
      Description: description,
      Enabled: news.enabled ?? true,
      ...(news.orderIndex !== undefined ? { OrderIndex: news.orderIndex } : {}),
    };
  });

type DesiredRule = Effect.Success<ReturnType<typeof desiredRule>>;

const sameRule = (live: Core.EdgeRuleV2Model, desired: DesiredRule) => {
  const param = (value: string | null | undefined) => value ?? "";
  const d = desired as DesiredRule & {
    ActionParameter1?: string;
    ActionParameter2?: string;
    ActionParameter3?: string;
    OrderIndex?: number;
  };
  const liveTriggers = (live.Triggers ?? []).map((trigger) => ({
    Type: trigger.Type,
    PatternMatches: [...(trigger.PatternMatches ?? [])],
    PatternMatchingType: trigger.PatternMatchingType,
  }));
  return (
    live.ActionType === d.ActionType &&
    param(live.ActionParameter1) === param(d.ActionParameter1) &&
    param(live.ActionParameter2) === param(d.ActionParameter2) &&
    param(live.ActionParameter3) === param(d.ActionParameter3) &&
    live.TriggerMatchingType === d.TriggerMatchingType &&
    live.Enabled === d.Enabled &&
    (d.OrderIndex === undefined || live.OrderIndex === d.OrderIndex) &&
    JSON.stringify(liveTriggers) === JSON.stringify(d.Triggers)
  );
};

const findRule = (
  zone: Core.PullZoneModel,
  guid: string | undefined,
  description: string,
) =>
  (zone.EdgeRules ?? []).find(
    (rule) => (guid !== undefined && rule.Guid === guid) || rule.Description === description,
  );

export const EdgeRuleProvider = () =>
  Provider.succeed(EdgeRule, {
    stables: ["pullZoneId"],
    // Non-listable: rules live inside pull zones that cannot be attributed
    // to Alchemy (no tags on bunny.net).
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.pullZone.pullZoneId !== output.pullZoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const pullZoneId = output?.pullZoneId ?? olds?.pullZone.pullZoneId;
      if (pullZoneId === undefined) return undefined;
      const description = output?.description ?? olds?.description ?? `alchemy:${fqn}`;
      const zone = yield* Core.getPullZone({ id: pullZoneId }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      const rule = zone === undefined ? undefined : findRule(zone, output?.guid, description);
      return rule?.Guid
        ? { pullZoneId, guid: rule.Guid, description: rule.Description ?? description }
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ fqn, news, output, session }) {
      const pullZoneId = news.pullZone.pullZoneId;
      const description = news.description ?? `alchemy:${fqn}`;
      const desired = yield* desiredRule(news, description);

      return yield* withPullZoneLock(pullZoneId)(
        Effect.gen(function* () {
          // 1. Observe
          const zone = yield* Core.getPullZone({ id: pullZoneId });
          const existing = findRule(zone, output?.guid, description);
          if (existing?.Guid && sameRule(existing, desired)) {
            return { pullZoneId, guid: existing.Guid, description };
          }

          // 2. Ensure / 3. Sync — passing the Guid updates in place; without
          // it the API creates a second rule.
          const saved = yield* Core.upsertEdgeRule({
            pullZoneId,
            ...desired,
            ...(existing?.Guid ? { Guid: existing.Guid } : {}),
          });
          let guid = saved.Guid ?? existing?.Guid ?? undefined;
          if (!guid) {
            const reread = yield* Core.getPullZone({ id: pullZoneId });
            guid = findRule(reread, undefined, description)?.Guid ?? undefined;
          }
          yield* session.note(`${existing ? "Updated" : "Created"} edge rule ${description}`);
          return { pullZoneId, guid: guid ?? "", description };
        }),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!output.guid) return;
      yield* withPullZoneLock(output.pullZoneId)(
        Core.deleteEdgeRule({ pullZoneId: output.pullZoneId, edgeRuleId: output.guid }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
