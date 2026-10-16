# alchemy-bunny-sdk

The Effect client for the [bunny.net](https://bunny.net) APIs behind [`alchemy-bunny`](https://github.com/ChrisCodess/alchemy-bunny). It is installed with the provider; apps do not import it, just as Alchemy apps never import the `@distilled.cloud/*` SDKs behind `alchemy`.

It covers:
- the core, Edge Scripting and Bunny Database APIs, generated from bunny.net's OpenAPI documents;
- Edge Storage and SQL over Hrana, both hand-written.

It needs only `effect` (`^4.0.0`, tested with `4.0.5`), so tooling that wants the raw API without Alchemy can use it directly: see [docs/sdk.md](https://github.com/ChrisCodess/alchemy-bunny/blob/main/docs/sdk.md).

Apache-2.0. Not affiliated with bunny.net.
