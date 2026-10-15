# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security → Advisories) on this repository rather than in a public issue.

## What the provider does with credentials

- The **account API key** (`BUNNY_API_KEY` or an Alchemy profile) is used only at deploy time and never bound into deployed code.
- Deployed code gets narrower credentials as **secrets**: storage zone passwords (the read-only one for `ReadStorageZone`), database tokens, and Edge Script fetch keys. Edge Script secrets cannot be read back through bunny.net's API.
- Alchemy **state** holds storage zone passwords, database tokens and generated secrets as `Redacted` values. Protect your state store as you would the credentials themselves.
- **Database tokens cannot be revoked one at a time**, and replacing a token does not revoke the old one. See [Token revocation](docs/database.md#token-revocation).
- **Forwarded URLs.** An Effect-native Edge Script honours `x-alchemy-forwarded-url` only with its fetch key, compared without early exit, and strips the forwarding headers from every request.
