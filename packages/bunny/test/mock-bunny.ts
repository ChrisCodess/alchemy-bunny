/**
 * In-memory stand-in for the bunny.net core API and Edge Storage API.
 *
 * It models the behaviour the provider depends on, as documented by
 * bunny.net, its OpenAPI spec, the official Terraform provider and the
 * official CLI:
 *
 *   - core API auth: `AccessKey: <account key>`; storage auth: `AccessKey:
 *     <zone password>`, or the read-only password for GET (PUT and DELETE
 *     with it are 401; probed 2026-09-29)
 *   - globally unique zone names: a taken name is a 400 whose message says so
 *   - POST /pullzone returns the created zone (the spec omits the body)
 *   - DELETE /storagezone defaults to deleting linked pull zones
 *   - storage PUT checks the `Checksum` header (uppercase hex SHA-256)
 *   - storage listings are one level deep and carry `Checksum`
 *
 * Calibrated against the live API on 2026-09-29:
 * 404s carry `{ ErrorKey, Field, Message }`; `GET /storagezone` ignores
 * `search`; `GET /pullzone?search=` answers with the page envelope; a
 * deleted storage zone's name stays blocked ("currently being deleted").
 *
 * Bunny Database (`/database/...`, calibrated 2026-09-29):
 * names are slugs of at most 16 characters (longer → 500) and not unique;
 * errors are `{ error, details? }`; an unknown id is 404 on GET but 500 on
 * PATCH/DELETE/token; revoke invalidates every token. SQL runs on an
 * in-memory `bun:sqlite` database per database behind a Hrana
 * `/v2/pipeline` endpoint (`execute`, `sequence`, `batch` with conditions, `close`); read-only
 * tokens get 403 on writes. Not modelled: `SQL_MANY_STATEMENTS` for a
 * multi-statement `execute`, and the transient 421.
 *
 * It is a test double: behaviour the live API has that this file does not
 * model is not covered by tests that use it.
 */
import { Database as SQLite } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export interface MockStorageZone {
  Id: number;
  Name: string;
  Password: string;
  ReadOnlyPassword: string;
  Region: string;
  ReplicationRegions: string[];
  ZoneTier: number;
  StorageZoneType: number;
  StorageHostname: string;
  Rewrite404To200: boolean;
  Custom404FilePath: string | null;
  Deleted: boolean;
}

export interface MockHostname {
  Id: number;
  Value: string;
  IsSystemHostname: boolean;
  HasCertificate: boolean;
  ForceSSL: boolean;
}

export interface MockPullZone {
  Id: number;
  Name: string;
  OriginType: number;
  OriginUrl: string | null;
  StorageZoneId: number;
  Type: number;
  EnableAutoSSL: boolean;
  /** true for every new zone on the live API (2026-09-29). */
  DisableCookies: boolean;
  CacheControlMaxAgeOverride: number;
  CacheControlPublicMaxAgeOverride: number;
  Hostnames: MockHostname[];
  EdgeRules: Record<string, any>[];
  EdgeScriptId: number | null;
  MiddlewareScriptId: number | null;
}

export interface MockEdgeScript {
  Id: number;
  Name: string;
  ScriptType: number;
  Code: string;
  CurrentReleaseId: number;
  EdgeScriptVariables: { Id: number; Name: string; DefaultValue: string; Required: boolean }[];
  Secrets: { Id: number; Name: string; Value: string }[];
  LinkedPullZones: { Id: number; PullZoneName: string; DefaultHostname: string }[];
  DefaultHostname: string | null;
}

export interface MockDatabase {
  id: string;
  name: string;
  storage_region: string;
  primary_regions: string[];
  replicas_regions: string[];
  sqlite: SQLite;
  /** token -> authorization; cleared by revoke */
  tokens: Map<string, { authorization: string; expires_at: string | null }>;
}

export interface MockFile {
  body: Uint8Array;
  checksum: string;
  contentType: string;
  lastModified: Date;
}

export interface MockRequest {
  method: string;
  path: string;
}

export const ACCOUNT_KEY = "mock-account-key";

const sha256 = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex").toUpperCase();

const error = (status: number, message: string, field = "") =>
  Response.json({ ErrorKey: "mock.error", Field: field, Message: message }, { status });

export const startMockBunny = () => {
  let nextId = 1000;
  const storageZones = new Map<number, MockStorageZone>();
  const pullZones = new Map<number, MockPullZone>();
  /** zone name -> key -> file */
  const files = new Map<string, Map<string, MockFile>>();
  const purges: number[] = [];
  const scripts = new Map<number, MockEdgeScript>();
  /** script id per publish */
  const publishes: number[] = [];
  const requests: MockRequest[] = [];
  /** Injected failures, consumed in order by the first matching request. */
  const faults: Array<{ method: string; path: string | RegExp; status: number; body: unknown }> = [];
  const uploads: string[] = [];
  const databases = new Map<string, MockDatabase>();
  let serverUrl = "";

  const takenNames = () =>
    new Set([
      ...[...storageZones.values()].filter((z) => !z.Deleted).map((z) => z.Name),
      ...[...pullZones.values()].map((z) => z.Name),
    ]);

  const handleCore = async (request: Request, url: URL): Promise<Response> => {
    if (request.headers.get("accesskey") !== ACCOUNT_KEY) {
      return Response.json({ Message: "Authorization has been denied for this request." }, { status: 401 });
    }
    const path = url.pathname;
    const body: any = request.method === "GET" ? undefined : await request.json().catch(() => ({}));
    let match: RegExpMatchArray | null;

    // ---- storage zones
    if (path === "/storagezone" && request.method === "GET") {
      // The live API ignores `search` here and returns every zone.
      return Response.json([...storageZones.values()].filter((z) => !z.Deleted));
    }
    if (path === "/storagezone" && request.method === "POST") {
      const name = String(body.Name ?? "");
      if (name.length < 4) return error(400, "The name must be at least 4 characters long.", "Name");
      if (name.length > 63 || !/^[a-zA-Z0-9-]+$/.test(name)) {
        return error(400, "StorageZone name must be between 4 and 63 characters and consist of numbers, letters or - only.", "Name");
      }
      if (takenNames().has(name)) return error(400, "The storage zone name is already taken.", "Name");
      if ([...storageZones.values()].some((z) => z.Deleted && z.Name === name)) {
        return error(400, "The storage zone is currently being deleted.", "Name");
      }
      const zone: MockStorageZone = {
        Id: nextId++,
        Name: name,
        Password: `pw-${name}`,
        ReadOnlyPassword: `ro-${name}`,
        Region: body.Region ?? "DE",
        ReplicationRegions: body.ReplicationRegions ?? [],
        ZoneTier: body.ZoneTier ?? 0,
        StorageZoneType: body.StorageZoneType ?? 0,
        StorageHostname: "storage.bunnycdn.com",
        Rewrite404To200: false,
        Custom404FilePath: null,
        Deleted: false,
      };
      storageZones.set(zone.Id, zone);
      files.set(zone.Name, new Map());
      return Response.json(zone, { status: 201 });
    }
    if ((match = path.match(/^\/storagezone\/(\d+)$/))) {
      const zone = storageZones.get(Number(match[1]));
      if (!zone || zone.Deleted) return error(404, "The requested Storage Zone was not found", "StorageZone");
      if (request.method === "GET") return Response.json(zone);
      if (request.method === "POST") {
        if (body.ReplicationZones) {
          const removed = zone.ReplicationRegions.filter((r) => !body.ReplicationZones.includes(r));
          if (removed.length) return error(400, "Replication regions cannot be removed.", "ReplicationZones");
          zone.ReplicationRegions = body.ReplicationZones;
        }
        if (body.Rewrite404To200 !== undefined && body.Rewrite404To200 !== null) zone.Rewrite404To200 = body.Rewrite404To200;
        // The API ignores null; an empty string clears the path.
        if (typeof body.Custom404FilePath === "string") zone.Custom404FilePath = body.Custom404FilePath || null;
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        zone.Deleted = true;
        files.delete(zone.Name);
        // Documented default: linked pull zones are deleted too.
        if (url.searchParams.get("deleteLinkedPullZones") !== "false") {
          for (const [id, pz] of pullZones) if (pz.StorageZoneId === zone.Id) pullZones.delete(id);
        }
        return new Response(null, { status: 204 });
      }
    }

    // ---- pull zones
    if (path === "/pullzone" && request.method === "GET") {
      const search = url.searchParams.get("search")?.toLowerCase();
      const items = [...pullZones.values()].filter(
        (z) => !search || z.Name.toLowerCase().includes(search),
      );
      // `page` or `search` answers with the page envelope (live API).
      return url.searchParams.has("page") || url.searchParams.has("search")
        ? Response.json({ Items: items, CurrentPage: 1, TotalItems: items.length, HasMoreItems: false })
        : Response.json(items);
    }
    if (path === "/pullzone" && request.method === "POST") {
      const name = String(body.Name ?? "");
      if (takenNames().has(name)) return error(400, "The pull zone name is already taken.", "Name");
      const zone: MockPullZone = {
        Id: nextId++,
        Name: name,
        OriginType: body.OriginType ?? 0,
        OriginUrl: body.OriginUrl ?? null,
        StorageZoneId: body.StorageZoneId ?? -1,
        Type: body.Type ?? 0,
        EnableAutoSSL: body.EnableAutoSSL ?? false,
        DisableCookies: body.DisableCookies ?? true,
        CacheControlMaxAgeOverride: body.CacheControlMaxAgeOverride ?? -1,
        CacheControlPublicMaxAgeOverride: body.CacheControlPublicMaxAgeOverride ?? -1,
        Hostnames: [
          { Id: nextId++, Value: `${name}.b-cdn.net`, IsSystemHostname: true, HasCertificate: true, ForceSSL: false },
        ],
        EdgeRules: [],
        EdgeScriptId: body.EdgeScriptId ?? null,
        MiddlewareScriptId: body.MiddlewareScriptId || null,
      };
      pullZones.set(zone.Id, zone);
      return Response.json(zone, { status: 201 });
    }
    if (path === "/pullzone/loadFreeCertificate" && request.method === "GET") {
      const hostname = url.searchParams.get("hostname");
      for (const zone of pullZones.values()) {
        const entry = zone.Hostnames.find((h) => h.Value === hostname);
        if (entry) {
          entry.HasCertificate = true;
          return new Response(null, { status: 200 });
        }
      }
      return error(400, "Hostname not found.");
    }
    // ---- edge rules
    if ((match = path.match(/^\/pullzone\/(\d+)\/edgerules\/addOrUpdate$/)) && request.method === "POST") {
      const zone = pullZones.get(Number(match[1]));
      if (!zone) return error(404, "The requested Pull Zone was not found", "PullZone");
      const existing = body.Guid ? zone.EdgeRules.findIndex((rule) => rule.Guid === body.Guid) : -1;
      const rule = { ...body, Guid: body.Guid || randomUUID(), OrderIndex: body.OrderIndex ?? zone.EdgeRules.length, ReadOnly: false };
      if (existing >= 0) zone.EdgeRules[existing] = rule;
      else zone.EdgeRules.push(rule);
      return Response.json(rule, { status: 201 });
    }
    if ((match = path.match(/^\/pullzone\/(\d+)\/edgerules\/([\w-]+)$/)) && request.method === "DELETE") {
      const zone = pullZones.get(Number(match[1]));
      if (!zone) return error(404, "The requested Pull Zone was not found", "PullZone");
      const before = zone.EdgeRules.length;
      zone.EdgeRules = zone.EdgeRules.filter((rule) => rule.Guid !== match![2]);
      return before === zone.EdgeRules.length ? error(404, "Edge rule not found") : new Response(null, { status: 204 });
    }

    // ---- edge scripts
    if (path === "/compute/script" && request.method === "GET") {
      const items = [...scripts.values()];
      return Response.json({ Items: items, CurrentPage: 1, TotalItems: items.length, HasMoreItems: false });
    }
    if (path === "/compute/script" && request.method === "POST") {
      const id = nextId++;
      const script: MockEdgeScript = {
        Id: id, Name: body.Name, ScriptType: body.ScriptType ?? 1,
        Code: body.Code ?? "/* starter code */", CurrentReleaseId: -1,
        EdgeScriptVariables: [], Secrets: [], LinkedPullZones: [], DefaultHostname: null,
      };
      if (body.CreateLinkedPullZone) {
        const pzName = `${body.Name}-mock1`;
        const pz: MockPullZone = {
          Id: nextId++, Name: pzName, OriginType: 4, OriginUrl: "https://bunnycdn.com", StorageZoneId: -1,
          Type: 0, EnableAutoSSL: false, DisableCookies: true, CacheControlMaxAgeOverride: -1, CacheControlPublicMaxAgeOverride: -1,
          Hostnames: [
            { Id: nextId++, Value: `${pzName}.b-cdn.net`, IsSystemHostname: true, HasCertificate: true, ForceSSL: false },
            { Id: nextId++, Value: `${pzName}.bunny.run`, IsSystemHostname: true, HasCertificate: true, ForceSSL: false },
          ],
          EdgeRules: [], EdgeScriptId: id, MiddlewareScriptId: null,
        };
        pullZones.set(pz.Id, pz);
        script.LinkedPullZones = [{ Id: pz.Id, PullZoneName: pzName, DefaultHostname: `https://${pzName}.bunny.run` }];
        script.DefaultHostname = `https://${pzName}.bunny.run`;
      }
      scripts.set(id, script);
      return Response.json(script, { status: 201 });
    }
    if ((match = path.match(/^\/compute\/script\/(\d+)(\/.*)?$/))) {
      const script = scripts.get(Number(match[1]));
      if (!script) return error(404, "The requested Edge Script was not found", "EdgeScript");
      const sub = match[2] ?? "";
      const withoutSecrets = () => { const { Secrets: _secrets, ...rest } = script; return rest; };
      if (sub === "" && request.method === "GET") return Response.json(withoutSecrets());
      if (sub === "" && request.method === "POST") {
        if (body.Name) script.Name = body.Name;
        return Response.json(withoutSecrets());
      }
      if (sub === "" && request.method === "DELETE") {
        scripts.delete(script.Id);
        if (url.searchParams.get("deleteLinkedPullZones") === "true") {
          for (const linked of script.LinkedPullZones) pullZones.delete(linked.Id);
        }
        for (const zone of pullZones.values()) if (zone.MiddlewareScriptId === script.Id) zone.MiddlewareScriptId = null;
        return new Response(null, { status: 204 });
      }
      if (sub === "/code" && request.method === "GET") return Response.json({ Code: script.Code, LastModified: "2026-09-29T00:00:00Z" });
      if (sub === "/code" && request.method === "POST") {
        script.Code = body.Code;
        return new Response(null, { status: 204 });
      }
      if (sub === "/publish" && request.method === "POST") {
        script.CurrentReleaseId = nextId++;
        publishes.push(script.Id);
        return new Response(null, { status: 204 });
      }
      if (sub === "/variables" && request.method === "PUT") {
        const existing = script.EdgeScriptVariables.find((variable) => variable.Name === body.Name);
        if (existing) existing.DefaultValue = body.DefaultValue;
        else script.EdgeScriptVariables.push({ Id: nextId++, Name: body.Name, DefaultValue: body.DefaultValue, Required: !!body.Required });
        return Response.json(script.EdgeScriptVariables.find((variable) => variable.Name === body.Name));
      }
      let sm: RegExpMatchArray | null;
      if ((sm = sub.match(/^\/variables\/(\d+)$/)) && request.method === "DELETE") {
        script.EdgeScriptVariables = script.EdgeScriptVariables.filter((variable) => variable.Id !== Number(sm![1]));
        return new Response(null, { status: 204 });
      }
      if (sub === "/secrets" && request.method === "GET") {
        return Response.json({ Secrets: script.Secrets.map(({ Id, Name }) => ({ Id, Name, LastModified: "2026-09-29T00:00:00Z" })) });
      }
      if (sub === "/secrets" && request.method === "PUT") {
        const existing = script.Secrets.find((secret) => secret.Name === body.Name);
        if (existing) existing.Value = body.Secret;
        else script.Secrets.push({ Id: nextId++, Name: body.Name, Value: body.Secret });
        const saved = script.Secrets.find((secret) => secret.Name === body.Name)!;
        return Response.json({ Id: saved.Id, Name: saved.Name });
      }
      if ((sm = sub.match(/^\/secrets\/(\d+)$/)) && request.method === "DELETE") {
        script.Secrets = script.Secrets.filter((secret) => secret.Id !== Number(sm![1]));
        return new Response(null, { status: 204 });
      }
    }

    if ((match = path.match(/^\/pullzone\/(\d+)(\/[a-zA-Z]+)?$/))) {
      const zone = pullZones.get(Number(match[1]));
      if (!zone) return error(404, "The requested Pull Zone was not found", "PullZone");
      const action = match[2];
      if (!action && request.method === "GET") return Response.json(zone);
      if (!action && request.method === "POST") {
        for (const key of [
          "OriginType", "OriginUrl", "StorageZoneId", "Type", "EnableAutoSSL", "DisableCookies",
          "CacheControlMaxAgeOverride", "CacheControlPublicMaxAgeOverride",
        ] as const) {
          if (body[key] !== undefined && body[key] !== null) (zone as any)[key] = body[key];
        }
        if (typeof body.MiddlewareScriptId === "number") zone.MiddlewareScriptId = body.MiddlewareScriptId || null;
        return Response.json(zone);
      }
      if (!action && request.method === "DELETE") {
        pullZones.delete(zone.Id);
        return new Response(null, { status: 204 });
      }
      if (action === "/addHostname" && request.method === "POST") {
        if (zone.Hostnames.some((h) => h.Value === body.Hostname)) return error(400, "The hostname is already registered.");
        zone.Hostnames.push({ Id: nextId++, Value: body.Hostname, IsSystemHostname: false, HasCertificate: false, ForceSSL: false });
        return new Response(null, { status: 204 });
      }
      if (action === "/removeHostname" && request.method === "DELETE") {
        const before = zone.Hostnames.length;
        zone.Hostnames = zone.Hostnames.filter((h) => h.Value !== body?.Hostname);
        return new Response(null, { status: before === zone.Hostnames.length ? 404 : 204 });
      }
      if (action === "/setForceSSL" && request.method === "POST") {
        const entry = zone.Hostnames.find((h) => h.Value === body.Hostname);
        if (!entry) return error(400, "Hostname not found.");
        entry.ForceSSL = body.ForceSSL;
        return new Response(null, { status: 204 });
      }
      if (action === "/purgeCache" && request.method === "POST") {
        purges.push(zone.Id);
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`mock: no route for ${request.method} ${path}`, { status: 501 });
  };

  const handleStorage = async (request: Request, url: URL): Promise<Response> => {
    const [, zoneName = "", ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const zone = [...storageZones.values()].find((z) => z.Name === zoneName && !z.Deleted);
    const zoneFiles = files.get(zoneName);
    if (!zone || !zoneFiles) return new Response("Zone not found", { status: 404 });
    const accessKey = request.headers.get("accesskey");
    const readOnly = accessKey === zone.ReadOnlyPassword && request.method === "GET";
    if (accessKey !== zone.Password && !readOnly) {
      return Response.json({ HttpCode: 401, Message: "Unauthorized" }, { status: 401 });
    }
    const key = rest.join("/");

    if (request.method === "PUT") {
      const body = new Uint8Array(await request.arrayBuffer());
      const checksum = sha256(body);
      const claimed = request.headers.get("checksum");
      if (claimed && claimed !== checksum) return new Response("Checksum mismatch", { status: 400 });
      zoneFiles.set(key, {
        body,
        checksum,
        contentType: request.headers.get("override-content-type") ?? "application/octet-stream",
        lastModified: new Date(),
      });
      uploads.push(key);
      return Response.json({ HttpCode: 201, Message: "File uploaded." }, { status: 201 });
    }
    if (request.method === "GET" && (key === "" || key.endsWith("/"))) {
      const dir = key;
      const entries = new Map<string, object>();
      for (const [fileKey, file] of zoneFiles) {
        if (!fileKey.startsWith(dir)) continue;
        const remainder = fileKey.slice(dir.length);
        const slash = remainder.indexOf("/");
        if (slash === -1) {
          entries.set(remainder, {
            ObjectName: remainder, Path: `/${zoneName}/${dir}`, IsDirectory: false,
            Length: file.body.length, Checksum: file.checksum, ContentType: file.contentType,
          });
        } else {
          const name = remainder.slice(0, slash);
          entries.set(`${name}/`, {
            ObjectName: name, Path: `/${zoneName}/${dir}`, IsDirectory: true, Length: 0, Checksum: null, ContentType: "",
          });
        }
      }
      return Response.json([...entries.values()]);
    }
    if (request.method === "GET") {
      const file = zoneFiles.get(key);
      return file
        ? new Response(file.body, {
            headers: {
              "Content-Type": file.contentType,
              ETag: `"${file.checksum.slice(0, 8).toLowerCase()}-${file.body.length.toString(16)}"`,
              "Last-Modified": file.lastModified.toUTCString(),
            },
          })
        : Response.json({ HttpCode: 404, Message: "Object Not Found" }, { status: 404 });
    }
    if (request.method === "DELETE") {
      let deleted = 0;
      for (const fileKey of [...zoneFiles.keys()]) {
        if (fileKey === key || (key.endsWith("/") && fileKey.startsWith(key))) {
          zoneFiles.delete(fileKey);
          deleted++;
        }
      }
      return new Response(null, { status: deleted ? 200 : 404 });
    }
    return new Response("mock: unsupported storage request", { status: 501 });
  };

  const dbError = (status: number, message: string, details?: unknown) =>
    Response.json(details === undefined ? { error: message } : { error: message, details }, { status });
  const REGION_GROUPS: Record<string, string> = { DE: "EU", UK: "EU", FR: "EU", NY: "NA", LA: "NA", SG: "ASIA" };
  const dbView = (db: MockDatabase) => ({
    name: db.name,
    id: db.id,
    url: `${serverUrl}/sql/${db.id}/`,
    block_reads: false,
    block_writes: false,
    size_max: "1024.0 MB",
    current_size: "0 B",
    size_max_bytes: 1024000000,
    current_size_bytes: 0,
    storage_region: db.storage_region,
    primary_regions: db.primary_regions,
    replicas_regions: db.replicas_regions,
  });

  const handleDatabase = async (request: Request, url: URL): Promise<Response> => {
    if (request.headers.get("accesskey") !== ACCOUNT_KEY) {
      return dbError(401, request.headers.get("accesskey") ? "Invalid AccessKey" : "Authentification issues");
    }
    const path = url.pathname.slice("/database".length);
    const body: any = request.method === "GET" ? undefined : await request.json().catch(() => ({}));
    let match: RegExpMatchArray | null;

    if (path === "/v1/config" && request.method === "GET") {
      return Response.json({
        storage_region_available: [
          { id: "eu-west-1", name: "Europe", group: "EU" },
          { id: "us-east-1", name: "North America", group: "NA" },
        ],
        primary_regions: Object.entries(REGION_GROUPS).map(([id, group]) => ({
          id, name: id, latitude: 0, longitude: 0, group, country: { alpha2: "DE" },
        })),
        replica_regions: [],
      });
    }
    if (path === "/v2/databases" && request.method === "GET") {
      const page = Number(url.searchParams.get("page"));
      if (!page) return new Response("Failed to deserialize query string: missing field `page`", { status: 400 });
      const perPage = Number(url.searchParams.get("per_page") ?? 50);
      const search = url.searchParams.get("search");
      const all = [...databases.values()].filter((db) => !search || db.name.includes(search));
      const items = all.slice((page - 1) * perPage, page * perPage);
      return Response.json({
        databases: items.map(dbView),
        page_info: { current_page: page, total_items: all.length, has_more_items: page * perPage < all.length },
      });
    }
    if (path === "/v2/databases" && request.method === "POST") {
      const name = String(body.name ?? "");
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return dbError(400, "invalid request", { err: `name: \`${name}\` is not a slug` });
      }
      if (name.length > 16) return dbError(500, "Internal error");
      if (!["eu-west-1", "us-east-1"].includes(body.storage_region)) {
        return dbError(500, `This storage region ${body.storage_region} is not supported.`);
      }
      if (!Array.isArray(body.primary_regions) || body.primary_regions.length === 0) {
        return dbError(500, "Internal error.");
      }
      const db: MockDatabase = {
        id: `db_${randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`,
        name,
        storage_region: body.storage_region,
        primary_regions: [...body.primary_regions],
        replicas_regions: [...(body.replicas_regions ?? [])],
        sqlite: new SQLite(":memory:"),
        tokens: new Map(),
      };
      databases.set(db.id, db);
      return Response.json({ db_id: db.id });
    }
    if ((match = path.match(/^\/v2\/databases\/([^/]+)(\/auth\/(generate|revoke))?$/))) {
      if (!match[1]!.startsWith("db_")) {
        return new Response("Invalid URL: A Database ID should start with `db_`.", { status: 400 });
      }
      const db = databases.get(match[1]!);
      if (!db) return request.method === "GET" ? dbError(404, "The database has not been found.") : dbError(500, "Internal error");
      if (match[3] === "generate" && request.method === "PUT") {
        const token = `mock-jwt-${db.id}-${randomUUID()}`;
        db.tokens.set(token, { authorization: body.authorization, expires_at: body.expires_at ?? null });
        return Response.json({ token, expires_at: body.expires_at ?? null });
      }
      if (match[3] === "revoke" && request.method === "POST") {
        db.tokens.clear();
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") return Response.json({ db: dbView(db) });
      if (request.method === "PATCH") {
        if (body.primary_regions !== undefined) {
          if (body.primary_regions.length === 0) return dbError(500, "issue while saving the group");
          db.primary_regions = [...body.primary_regions];
        }
        if (body.replicas_regions !== undefined) db.replicas_regions = [...body.replicas_regions];
        return Response.json({ db: dbView(db) });
      }
      if (request.method === "DELETE") {
        databases.delete(db.id);
        db.sqlite.close();
        return Response.json({ db_id: db.id });
      }
    }
    return new Response("mock: unsupported database request", { status: 501 });
  };

  const toWire = (value: unknown) =>
    value === null
      ? { type: "null" }
      : typeof value === "number"
        ? Number.isInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value }
        : typeof value === "bigint"
          ? { type: "integer", value: value.toString() }
          : value instanceof Uint8Array
            ? { type: "blob", base64: Buffer.from(value).toString("base64").replace(/=+$/, "") }
            : { type: "text", value: String(value) };
  const fromWire = (value: any) =>
    value.type === "null" ? null
      : value.type === "integer" ? Number(value.value)
        : value.type === "blob" ? Buffer.from(value.base64, "base64")
          : value.value;
  const WRITE = /^\s*(insert|update|delete|create|drop|alter|replace)\b/i;

  /** Hrana over HTTP, enough for the migration executor. */
  const handleSql = async (request: Request, url: URL): Promise<Response> => {
    const match = url.pathname.match(/^\/sql\/([^/]+)\/v2\/pipeline$/);
    const db = match ? databases.get(match[1]!) : undefined;
    if (!db || request.method !== "POST") return new Response("mock: unknown database", { status: 404 });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const grant = db.tokens.get(token);
    if (!grant) return dbError(401, "Unauthorized: `The JWT is invalid`");
    const body: any = await request.json();
    const checkWrite = (sql: string) => {
      if (grant.authorization === "read-only" && WRITE.test(sql)) throw new Error("Authorization forbidden");
    };
    const execute = (stmt: any) => {
      checkWrite(stmt.sql);
      const statement = db.sqlite.prepare(stmt.sql);
      const args = (stmt.args ?? []).map(fromWire);
      const rows = (statement.values(...args) ?? []) as unknown[][];
      const changes = (db.sqlite.prepare("SELECT changes() AS n, last_insert_rowid() AS id").get() as { n: number; id: number });
      return {
        cols: statement.columnNames.map((name) => ({ name })),
        rows: rows.map((row) => row.map(toWire)),
        affected_row_count: WRITE.test(stmt.sql) ? changes.n : 0,
        last_insert_rowid: WRITE.test(stmt.sql) ? String(changes.id) : null,
      };
    };
    const sqlError = (cause: unknown) => ({ message: `SQLite error: ${(cause as Error).message}`, code: "SQLITE_UNKNOWN" });
    const results = (body.requests as any[]).map((step) => {
      try {
        if (step.type === "close") return { type: "ok", response: { type: "close" } };
        if (step.type === "sequence") {
          checkWrite(step.sql);
          db.sqlite.run(step.sql);
          return { type: "ok", response: { type: "sequence" } };
        }
        if (step.type === "batch") {
          const stepResults: unknown[] = [];
          const stepErrors: unknown[] = [];
          const holds = (cond: any): boolean =>
            cond === undefined || cond === null
              ? true
              : cond.type === "ok"
                ? stepResults[cond.step] != null
                : cond.type === "error"
                  ? stepErrors[cond.step] != null
                  : cond.type === "not"
                    ? !holds(cond.cond)
                    : cond.type === "and"
                      ? cond.conds.every(holds)
                      : cond.type === "or"
                        ? cond.conds.some(holds)
                        : false;
          for (const batchStep of step.batch.steps as any[]) {
            if (!holds(batchStep.condition)) {
              stepResults.push(null);
              stepErrors.push(null);
              continue;
            }
            try {
              stepResults.push(execute(batchStep.stmt));
              stepErrors.push(null);
            } catch (cause) {
              stepResults.push(null);
              stepErrors.push(sqlError(cause));
            }
          }
          return { type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } } };
        }
        return { type: "ok", response: { type: "execute", result: execute(step.stmt) } };
      } catch (cause) {
        return { type: "error", error: sqlError(cause) };
      }
    });
    return Response.json({ baton: null, base_url: null, results });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      const fault = faults.find(
        (candidate) =>
          candidate.method === request.method &&
          (typeof candidate.path === "string" ? candidate.path === url.pathname : candidate.path.test(url.pathname)),
      );
      if (fault !== undefined) {
        faults.splice(faults.indexOf(fault), 1);
        return Response.json(fault.body, { status: fault.status });
      }
      if (url.pathname.startsWith("/database/")) return handleDatabase(request, url);
      if (url.pathname.startsWith("/sql/")) return handleSql(request, url);
      // Core API routes start with a known resource; everything else is storage.
      return /^\/(storagezone|pullzone|purge|dnszone|compute)(\/|$)/.test(url.pathname)
        ? handleCore(request, url)
        : handleStorage(request, url);
    },
  });

  serverUrl = `http://127.0.0.1:${server.port}`;

  return {
    url: serverUrl,
    databases,
    storageZones,
    pullZones,
    files,
    purges,
    scripts,
    publishes,
    requests,
    uploads,
    /** Answer the next request matching `method` and `path` with `status` instead of handling it. */
    failNext: (method: string, path: string | RegExp, status: number, body: unknown = { error: "Internal error" }) => {
      faults.push({ method, path, status, body });
    },
    stop: () => server.stop(true),
  };
};

export type MockBunny = ReturnType<typeof startMockBunny>;
