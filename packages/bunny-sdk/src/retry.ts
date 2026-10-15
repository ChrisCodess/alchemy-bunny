/**
 * Bunny retry configuration.
 *
 * The per-SDK `Retry` service tag that generated operations wire into
 * `API.make`. Install a policy at the layer level and every Bunny API call
 * below it picks it up:
 *
 * @example
 * ```ts
 * myEffect.pipe(Bunny.Retry.transient);
 * Effect.provide(myEffect, Layer.succeed(Bunny.Retry.Retry, customPolicy));
 * ```
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Policy,
  throttlingFactory,
  transientFactory,
} from "@distilled.cloud/core/retry";

export {
  type Options,
  type Factory,
  type Policy,
  makeDefault,
  jittered,
  capped,
  throttlingOptions,
  transientOptions,
  throttlingFactory,
  transientFactory,
} from "@distilled.cloud/core/retry";

/** Context tag for the retry behaviour of Bunny API calls. */
export class Retry extends Context.Service<Retry, Policy>()("BunnyRetry") {}

/** Provides a custom retry policy to every Bunny API call below it. */
export const policy = (optionsOrFactory: Policy) =>
  Effect.provide(Layer.succeed(Retry, optionsOrFactory));

/** Disables all automatic retries. */
export const none = Effect.provide(
  Layer.succeed(Retry, { while: () => false }),
);

/** Retries throttling errors indefinitely. */
export const throttling = policy(throttlingFactory);

/** Retries all transient errors indefinitely. */
export const transient = policy(transientFactory);
