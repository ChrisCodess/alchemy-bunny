import { Namespace, type NamespaceNode } from "alchemy/Namespace";
import type { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import type { EdgeScript } from "./EdgeScript.ts";
import { fetchKeyLogicalId } from "./EdgeScriptFetch.ts";

/**
 * The key a callee Edge Script checks on forwarded requests: one
 * `Alchemy.Random` per callee, declared in the callee's own namespace, so
 * every caller — a `FetchEdgeScript` binding in a script's init, an `env`
 * binding inside a composite's namespace — declares the same resource and
 * binds the same value onto the callee. `declare` is `Alchemy.Random`'s
 * constructor (`yield* Random` in a layer, as Alchemy's capabilities do).
 *
 * @internal
 */
export const fetchKeyOf = <E, R>(declare: (id: string) => Effect.Effect<Random, E, R>, callee: EdgeScript) =>
  // `CurrentNamespace` is `serviceOption(Namespace)` read with
  // `getOrUndefined`, so providing `undefined` declares at the root (a
  // top-level callee). Omitting the service would not: `provideContext`
  // merges into the ambient context, so an enclosing namespace survives.
  Effect.provideService(declare(fetchKeyLogicalId(callee)), Namespace, callee.Namespace as NamespaceNode);
