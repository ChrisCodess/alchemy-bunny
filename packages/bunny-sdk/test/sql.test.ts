/**
 * The SQL client's retry policy, against a stub HttpClient: client errors are
 * not retried, a lost response is retried for a single statement but never
 * for a transaction, and a refused transaction (421, 429) is.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Sql } from "../src/index.ts";

const connection: Sql.DatabaseConnection = { url: "libsql://db.test", authToken: Redacted.make("token") };
const script = ["CREATE TABLE t (id INTEGER)"];
const okResult = () =>
  Response.json({ results: [{ type: "ok", response: { type: "execute", result: { cols: [], rows: [] } } }] });

/** A client answering from `responses` in order; `"lost"` fails at the transport level. */
const responding = (responses: Array<Response | "lost">) => {
  let index = 0;
  const seen: string[] = [];
  const client = HttpClient.make((request) => {
    seen.push(request.method);
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return next === "lost"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "lost" }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, next));
  });
  return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, layer: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

const failureTag = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  layer: Layer.Layer<HttpClient.HttpClient>,
) =>
  run(
    effect.pipe(
      Effect.result,
      Effect.map((result) => (Result.isFailure(result) ? result.failure._tag : undefined)),
    ),
    layer,
  );

describe("SQL client retries", () => {
  test("a 400 is SqlHttpError and is not retried", async () => {
    const { seen, layer } = responding([new Response("bad request", { status: 400 })]);
    expect(await failureTag(Sql.query(connection, "SELECT 1"), layer)).toBe("SqlHttpError");
    expect(seen.length).toBe(1);
  });

  test("a single statement is retried after a lost response", async () => {
    const { seen, layer } = responding(["lost", okResult()]);
    await run(Sql.query(connection, "SELECT 1"), layer);
    expect(seen.length).toBe(2);
  });

  test("a transaction is not re-sent after a lost response", async () => {
    const { seen, layer } = responding(["lost", okResult()]);
    expect(await failureTag(Sql.transaction(connection, script), layer)).toBe("SqlTransportError");
    expect(seen.length).toBe(1);
  });

  test("a transaction is not re-sent after a gateway 502, but is after a 421", async () => {
    const gateway = responding([new Response("bad gateway", { status: 502 }), okResult()]);
    expect(await failureTag(Sql.transaction(connection, script), gateway.layer)).toBe("SqlUnavailable");
    expect(gateway.seen.length).toBe(1);

    const struggling = responding([new Response("struggling to contact your database", { status: 421 }), okResult()]);
    await run(Sql.transaction(connection, script), struggling.layer);
    expect(struggling.seen.length).toBe(2);
  });
});
