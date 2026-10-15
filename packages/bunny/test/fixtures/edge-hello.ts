import * as BunnySDK from "@bunny.net/edgescript-sdk";

declare const Deno: { env: { get(name: string): string | undefined } };

BunnySDK.net.http.serve((request: Request) =>
  Response.json({ greeting: Deno.env.get("GREETING"), path: new URL(request.url).pathname }),
);
