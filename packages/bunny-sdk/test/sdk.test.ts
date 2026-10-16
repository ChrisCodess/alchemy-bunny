import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { inspect } from "node:util";
import * as Bunny from "../src/index.ts";

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body as { _tag: string; body?: unknown };
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body as Uint8Array);
  if (body._tag === "Raw") return String(body.body);
  return "";
};

/** A stub HTTP client that records requests and answers from `handler`. */
const stub = (handler: (request: Seen, index: number) => Response) => {
  const seen: Seen[] = [];
  const layer = Layer.mergeAll(
    Bunny.fromApiKey({ apiKey: "test-account-key", apiBaseUrl: "https://api.test" }),
    Layer.succeed(Bunny.Retry.Retry, { while: () => false }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const entry: Seen = {
            method: request.method,
            url: new URL(request.url),
            headers: { ...(request.headers as Record<string, string>) },
            body: bodyText(request),
          };
          seen.push(entry);
          return HttpClientResponse.fromWeb(request, handler(entry, seen.length - 1));
        }),
      ),
    ),
  );
  return { layer, seen };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<any, any, never>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const failureTag = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<any, any, never>,
): Promise<string | undefined> =>
  run(
    effect.pipe(
      Effect.result,
      Effect.map((result) => (Result.isFailure(result) ? result.failure._tag : undefined)),
    ),
    layer,
  );

describe("core API", () => {
  test("createPullZone sends the AccessKey and decodes the created zone from the 201 body", async () => {
    const { layer, seen } = stub(() =>
      Response.json(
        { Id: 42, Name: "site-a1b2", OriginType: 2, StorageZoneId: 7, Hostnames: [] },
        { status: 201 },
      ),
    );
    const zone = await run(
      Bunny.Core.createPullZone({ Name: "site-a1b2", OriginType: 2, StorageZoneId: 7 }),
      layer,
    );
    expect(zone.Id).toBe(42);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url.href).toBe("https://api.test/pullzone");
    expect(seen[0]!.headers["accesskey"]).toBe("test-account-key");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ Name: "site-a1b2", OriginType: 2, StorageZoneId: 7 });
  });

  test("a taken storage zone name surfaces as NameTaken (400 with a message)", async () => {
    const { layer } = stub(() =>
      Response.json(
        { ErrorKey: "storagezone.name_taken", Field: "Name", Message: "The storage zone name is already taken." },
        { status: 400 },
      ),
    );
    expect(await failureTag(Bunny.Core.createStorageZone({ Name: "taken", Region: "DE" }), layer)).toBe(
      "NameTaken",
    );
  });

  test("a taken pull zone name surfaces as NameTaken (409)", async () => {
    const { layer } = stub(() => Response.json({ Message: "Conflict" }, { status: 409 }));
    expect(await failureTag(Bunny.Core.createPullZone({ Name: "taken" }), layer)).toBe("NameTaken");
  });

  test("other 400s stay BadRequest", async () => {
    const { layer } = stub(() =>
      Response.json({ ErrorKey: "storagezone.region", Field: "Region", Message: "Invalid region" }, { status: 400 }),
    );
    expect(await failureTag(Bunny.Core.createStorageZone({ Name: "zone", Region: "XX" }), layer)).toBe(
      "BadRequest",
    );
  });

  test("a 404 with an empty body is NotFound", async () => {
    const { layer } = stub(() => new Response(null, { status: 404 }));
    expect(await failureTag(Bunny.Core.getPullZone({ id: 1 }), layer)).toBe("NotFound");
  });

  test("storage zone passwords decode as Redacted", async () => {
    const { layer } = stub(() =>
      Response.json({ Id: 7, Name: "zone", Password: "secret-pw", StorageHostname: "storage.bunnycdn.com" }),
    );
    const zone = await run(Bunny.Core.getStorageZone({ id: 7 }), layer);
    expect(Redacted.isRedacted(zone.Password)).toBe(true);
    expect(Redacted.value(zone.Password as Redacted.Redacted<string>)).toBe("secret-pw");
  });

  test("listPullZones decodes a plain array and a page envelope", async () => {
    const plain = stub(() => Response.json([{ Id: 1, Name: "a" }]));
    const envelope = stub(() =>
      Response.json({ Items: [{ Id: 2, Name: "b" }], CurrentPage: 1, TotalItems: 1, HasMoreItems: false }),
    );
    const fromPlain = await run(Bunny.Core.listPullZones({}), plain.layer);
    const fromEnvelope = await run(Bunny.Core.listPullZones({}), envelope.layer);
    expect(Array.isArray(fromPlain)).toBe(true);
    expect((fromPlain as ReadonlyArray<{ Id?: number }>)[0]!.Id).toBe(1);
    expect((fromEnvelope as { Items?: ReadonlyArray<{ Id?: number }> }).Items![0]!.Id).toBe(2);
  });

  test("paged lists stop when HasMoreItems is false", async () => {
    const { layer, seen } = stub((request) => {
      const page = Number(request.url.searchParams.get("page"));
      return Response.json({
        Items: [{ Id: page, Domain: `zone${page}.example` }],
        CurrentPage: page,
        TotalItems: 2,
        HasMoreItems: page < 2,
      });
    });
    const items = await run(Stream.runCollect(Bunny.Core.listDnsZones.items({})), layer);
    expect(Array.from(items).map((zone) => zone.Id)).toEqual([1, 2]);
    expect(seen.map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });
});

describe("database API", () => {
  // Bodies below have the shape the live API returned (2026-09-29; ids replaced).
  const db = {
    id: "db_01J0000000000000000EXAMPLE1",
    name: "notes",
    url: "libsql://01J0000000000000000EXAMPLE2-notes.lite.bunnydb.net/",
    block_reads: false,
    block_writes: false,
    size_max_bytes: 1024000000,
    current_size_bytes: 0,
    storage_region: "eu-west-1",
    primary_regions: ["DE"],
    replicas_regions: [],
  };

  test("createDatabase goes to /database/v2/databases with the AccessKey", async () => {
    const { layer, seen } = stub(() => Response.json({ db_id: db.id }));
    const created = await run(
      Bunny.Database.createDatabase({
        name: "notes",
        storage_region: "eu-west-1",
        primary_regions: ["DE"],
        replicas_regions: [],
      }),
      layer,
    );
    expect(created.db_id).toBe(db.id);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url.href).toBe("https://api.test/database/v2/databases");
    expect(seen[0]!.headers["accesskey"]).toBe("test-account-key");
    expect(JSON.parse(seen[0]!.body)).toEqual({
      name: "notes",
      storage_region: "eu-west-1",
      primary_regions: ["DE"],
      replicas_regions: [],
    });
  });

  test("getDatabase decodes a database without the deprecated size strings", async () => {
    const { layer, seen } = stub(() => Response.json({ db }));
    const read = await run(Bunny.Database.getDatabase({ db_id: db.id }), layer);
    expect(read.db.url).toBe(db.url);
    expect(seen[0]!.url.pathname).toBe(`/database/v2/databases/${db.id}`);
  });

  test("an unknown database is NotFound, with the API's message", async () => {
    const { layer } = stub(() => Response.json({ error: "The database has not been found." }, { status: 404 }));
    const failure = await run(
      Bunny.Database.getDatabase({ db_id: db.id }).pipe(Effect.flip),
      layer,
    );
    expect(failure._tag).toBe("NotFound");
    expect((failure as { message: string }).message).toBe("The database has not been found.");
  });

  test("an invalid name is BadRequest, with the details in the message", async () => {
    const { layer } = stub(() =>
      Response.json(
        { error: "invalid request", details: { err: "name: `Bad Name` is not a slug" } },
        { status: 400 },
      ),
    );
    const failure = await run(
      Bunny.Database.createDatabase({
        name: "Bad Name",
        storage_region: "eu-west-1",
        primary_regions: ["DE"],
        replicas_regions: [],
      }).pipe(Effect.flip),
      layer,
    );
    expect(failure._tag).toBe("BadRequest");
    expect((failure as { message: string }).message).toContain("is not a slug");
  });

  test("a plain-text 400 keeps its text as the message", async () => {
    const { layer } = stub(
      () => new Response("Invalid URL: A Database ID should start with `db_`.", { status: 400 }),
    );
    const failure = await run(Bunny.Database.listDatabases({ page: 1 }).pipe(Effect.flip), layer);
    expect(failure._tag).toBe("BadRequest");
    expect((failure as { message: string }).message).toContain("should start with `db_`");
  });

  test("generated tokens decode as Redacted", async () => {
    const { layer, seen } = stub(() => Response.json({ token: "eyJ.test.jwt", expires_at: null }));
    const generated = await run(
      Bunny.Database.generateDatabaseToken({ db_id: db.id, authorization: "full-access" }),
      layer,
    );
    expect(Redacted.isRedacted(generated.token)).toBe(true);
    expect(Redacted.value(generated.token as Redacted.Redacted<string>)).toBe("eyJ.test.jwt");
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url.pathname).toBe(`/database/v2/databases/${db.id}/auth/generate`);
  });
});

describe("storage API", () => {
  const access: Bunny.Storage.StorageZoneAccess = {
    hostname: "storage.test",
    zoneName: "my-zone",
    password: Redacted.make("zone-password"),
  };

  test("putObject sends the zone password, checksum, and content type", async () => {
    const { layer, seen } = stub(() => new Response(null, { status: 201 }));
    const body = new TextEncoder().encode("hello bunny\n");
    const checksum = Bunny.checksumOf(body);
    await run(
      Bunny.Storage.putObject(access, "assets/app one.js", body, {
        checksum,
        contentType: "text/javascript",
      }),
      layer,
    );
    expect(checksum).toMatch(/^[0-9A-F]{64}$/);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url.href).toBe("https://storage.test/my-zone/assets/app%20one.js");
    expect(seen[0]!.headers["accesskey"]).toBe("zone-password");
    expect(seen[0]!.headers["checksum"]).toBe(checksum);
    expect(seen[0]!.headers["override-content-type"]).toBe("text/javascript");
    expect(seen[0]!.body).toBe("hello bunny\n");
  });

  test("listFiles walks directories and returns file keys relative to the zone root", async () => {
    const { layer, seen } = stub((request) => {
      if (request.url.pathname === "/my-zone/") {
        return Response.json([
          { ObjectName: "index.html", Path: "/my-zone/", IsDirectory: false, Length: 10, Checksum: "AA", ContentType: "text/html" },
          { ObjectName: "about", Path: "/my-zone/", IsDirectory: true, Length: 0, Checksum: null },
        ]);
      }
      if (request.url.pathname === "/my-zone/about/") {
        return Response.json([
          { ObjectName: "index.html", Path: "/my-zone/about/", IsDirectory: false, Length: 12, Checksum: "BB", ContentType: "text/html" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    const files = await run(Bunny.Storage.listFiles(access), layer);
    expect(files.map((file) => [file.key, file.checksum])).toEqual([
      ["index.html", "AA"],
      ["about/index.html", "BB"],
    ]);
    expect(seen.every((request) => request.headers["accept"] === "application/json")).toBe(true);
  });

  test("deleteObject treats a missing file as deleted", async () => {
    const { layer } = stub(() => new Response(null, { status: 404 }));
    await run(Bunny.Storage.deleteObject(access, "gone.txt"), layer);
  });

  test("throttled requests are retried", async () => {
    const { layer, seen } = stub((_, index) =>
      index === 0 ? new Response("Unable to process request", { status: 400 }) : new Response(null, { status: 201 }),
    );
    await run(Bunny.Storage.putObject(access, "a.txt", new Uint8Array([1])), layer);
    expect(seen.length).toBe(2);
  });

  test("a checksum mismatch is a StorageBadRequest and is not retried", async () => {
    const { layer, seen } = stub(() => new Response("Checksum mismatch", { status: 400 }));
    expect(
      await failureTag(Bunny.Storage.putObject(access, "a.txt", new Uint8Array([1]), { checksum: "00" }), layer),
    ).toBe("StorageBadRequest");
    expect(seen.length).toBe(1);
  });
});

describe("AccessKey redaction", () => {
  const SECRET = "SECRET-ACCESS-KEY-VALUE";
  /** A client whose every request fails at the transport level. */
  const failing = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
      }),
    ),
  );
  const render = (value: unknown) => {
    let json = "";
    try {
      json = JSON.stringify(value) ?? "";
    } catch {}
    return `${inspect(value, { depth: 12 })}\n${json}`;
  };

  test("an error leaving the client carries the placeholder instead of the key", async () => {
    const client = Bunny.redactAccessKey(failing);
    const request = HttpClientRequest.get("https://api.test/storagezone").pipe(
      HttpClientRequest.setHeader(Bunny.ACCESS_KEY_HEADER, SECRET),
    );
    const exit = await Effect.runPromiseExit(client.execute(request));
    expect(Exit.isFailure(exit)).toBe(true);
    const rendered = render(exit) + (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain("<redacted>");
    // The error is still the typed one, with its message.
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(HttpClientError.HttpClientError);
    expect((error as HttpClientError.HttpClientError).reason._tag).toBe("TransportError");
    expect((error as Error).message).toContain("connection refused");
  });

  test("a Core API failure through the SDK carries no key either", async () => {
    const layer = Layer.mergeAll(
      Bunny.fromApiKey({ apiKey: SECRET, apiBaseUrl: "https://api.test" }),
      Layer.succeed(Bunny.Retry.Retry, { while: () => false }),
      Layer.succeed(HttpClient.HttpClient, Bunny.redactAccessKey(failing)),
    );
    const exit = await Effect.runPromiseExit(Bunny.Core.listStorageZones({}).pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(render(exit)).not.toContain(SECRET);
  });

  test("the unwrapped client would have printed it", async () => {
    const request = HttpClientRequest.get("https://api.test/x").pipe(
      HttpClientRequest.setHeader(Bunny.ACCESS_KEY_HEADER, SECRET),
    );
    const exit = await Effect.runPromiseExit(failing.execute(request));
    expect(render(exit)).toContain(SECRET);
  });
});
