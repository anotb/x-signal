# Changelog

## 0.1.0-rc.5

First public release candidate.

- Parallel Top, Latest, and Media research with filters, saved evidence, and selective continuation.
- Exact feeds, account discovery, post/thread/reply/quote context, monitors, and exports.
- Persistent Chromium with noVNC and optional Chrome session sync.
- ChatGPT and Codex MCP support with standard `search` and `fetch` tools.
- Stable private ChatGPT connectivity through an optional, immutable-pinned Secure MCP Tunnel sidecar with file-backed credentials and readiness checks.
- Restart recovery, account-bound provenance, bounded caches, adaptive backoff, and Dockerfiles validated for linux/amd64 and linux/arm64.
- Windows checkout protection for the Linux browser entrypoint, including LF normalization in source and a defensive image-build conversion.
- Passive operation capture without automatic duplicate GraphQL replay requests; lazy loading remains browser-driven.
