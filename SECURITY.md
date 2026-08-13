# Security and private-data handling

X Signal is intentionally local-first. Its browser volume, application volume, backups, exports, logs, screenshots, and local ChatGPT registration may contain sensitive account data.

Never commit or publish:

- browser profiles, cookies, storage, VNC secrets, or session-source identifiers;
- SQLite files, exports, backups, logs, raw screenshots, or captured X payloads;
- actual posts, post IDs, authors, bookmarks, feed contents, or research evidence;
- X account handles used for acceptance, ChatGPT registration IDs, tunnel IDs, runtime keys, temporary tunnel URLs, or local user paths.

Only synthetic parser fixtures belong in the test suite. Explicitly allowlisted public-topic screenshots under `docs/assets` are a narrow exception: each must be an unedited, manually reviewed ChatGPT answer that excludes account UI, browser chrome, private feeds, bookmarks, session state, local paths, registration details, and tunnel credentials. Do not add an image without reviewing it to that standard and adding it to the privacy-check allowlist.

`npm run test:privacy` rejects unknown image assets, known private artifact paths, and sensitive identifiers. Before publishing, use a clean squashed history created from a privacy-checked tree; do not publish this development repository's historical commits.

The Docker Compose ports bind to loopback by default. The optional Secure MCP Tunnel makes only outbound requests, reads its restricted runtime key from ignored `.secrets`, and talks to X Signal over the private Compose network. Keep both `.env` and `.secrets` out of archives and commits. The short-lived fallback exposes a random secret path through a loopback proxy; leave bearer auth unset for that specific **No Auth** flow and never tunnel port 7345 directly. Treat its printed URL and every browser-profile backup as credential-bearing material.

To report a vulnerability, use GitHub's **Security → Report a vulnerability** form for this repository. Do not open a public issue or include cookies, tokens, captured posts, or private feed data.
