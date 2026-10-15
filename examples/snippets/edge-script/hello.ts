// docs/edge-scripts.md: a bundled (non-Effect) Edge Script.
import * as BunnySDK from "@bunny.net/edgescript-sdk";

BunnySDK.net.http.serve((request) =>
  new Response(`${process.env.GREETING} from ${new URL(request.url).pathname}`),
);
