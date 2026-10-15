/**
 * Bunny pagination — hand-written.
 *
 * Paged list operations return `{ Items, CurrentPage, TotalItems,
 * HasMoreItems }` and take `page` (1-based) and `perPage` query parameters.
 * `CurrentPage` reports the page just returned, not the next one, so core's
 * page-number strategy would only stop on an empty page. This strategy
 * stops on `HasMoreItems: false`, and also on an empty page in case the flag
 * never clears (the official Bunny CLI guards the same way).
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  getPath,
  type PaginationStrategy,
} from "@distilled.cloud/core/pagination";

export const paginateHasMore: PaginationStrategy = (
  operation,
  input,
  pagination,
) => {
  const inputToken = pagination.inputToken ?? "page";
  const startPage =
    typeof input[inputToken] === "number" ? (input[inputToken] as number) : 1;

  return Stream.unfold({ page: startPage, done: false }, (state) =>
    Effect.gen(function* () {
      if (state.done) return undefined;
      const response = yield* operation({ ...input, [inputToken]: state.page });
      const items = pagination.items
        ? getPath(response, pagination.items)
        : undefined;
      const hasMore = getPath(response, "HasMoreItems") === true;
      const empty = Array.isArray(items) && items.length === 0;
      return [
        response,
        { page: state.page + 1, done: !hasMore || empty },
      ] as const;
    }),
  );
};
