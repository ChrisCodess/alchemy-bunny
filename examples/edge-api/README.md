# Effect-native Edge Script

A minimal `Bunny.EdgeScript` class: its init reads a `Config` value and a generated secret (`Alchemy.Random`), which Alchemy binds into the script's environment at deploy, the secret as an Edge Script secret, and its `fetch` serves requests. See [Edge Scripts](../../docs/edge-scripts.md).

```bash
cd examples/edge-api
BUNNY_API_KEY=... bun alchemy deploy
BUNNY_API_KEY=... bun alchemy destroy
```
