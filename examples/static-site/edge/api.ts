import * as BunnySDK from "@bunny.net/edgescript-sdk";

// Edge Scripts run on a Deno-based runtime; variables come from Deno.env.
declare const Deno: { env: { get(name: string): string | undefined } };

// A standalone Edge Script: bunny.net routes the script's hostname to this handler.
BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  return Response.json(
    {
      message: Deno.env.get("GREETING") ?? "Hello from a bunny.net Edge Script",
      path: url.pathname,
      time: new Date().toISOString(),
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    },
  );
});
