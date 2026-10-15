# Static site

A static site on bunny.net: an Edge Script with its own `*.bunny.run` hostname, and a site built with the script's URL. The site's files are synced to a storage zone behind a pull zone, with asset cache rules and a forced download.

```bash
bun install                       # at the repository root
cd examples/static-site
BUNNY_API_KEY=... bun alchemy deploy
BUNNY_API_KEY=... bun alchemy destroy
```

Outputs: `url` (the CDN), `apiUrl` (the Edge Script), `download` (a file served with `Content-Disposition: attachment`).
