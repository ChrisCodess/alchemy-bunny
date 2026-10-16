// docs/bindings.md: an Effect-native Edge Script reading and writing a
// storage zone through the ReadWriteStorageZone binding.
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Bunny from "alchemy-bunny";

export const Uploads = Bunny.StorageZone("Uploads", {});

export default class Files extends Bunny.EdgeScript<Files>()(
  "Files",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Bunny.ReadWriteStorageZone(yield* Uploads);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const key = new URL(request.url).pathname.slice(1);
        if (request.method === "PUT") {
          yield* uploads.put(key, new Uint8Array(yield* request.arrayBuffer));
          return HttpServerResponse.empty({ status: 201 });
        }
        const file = yield* uploads.get(key);
        return file === null
          ? HttpServerResponse.text("Not Found", { status: 404 })
          : HttpServerResponse.uint8Array(file.body, { contentType: file.contentType ?? undefined });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Bunny.ReadWriteStorageZoneHttp)),
) {}
