# Architecture

X Signal exposes MCP tools. ChatGPT or Codex presents the research in the conversation.

## Services

The default Compose stack has two services:

- `x-signal`: Node, MCP, scheduling, normalization, SQLite storage, monitoring, and exports.
- `browser`: persistent Chromium, Xvfb, noVNC, and a loopback CDP endpoint.

The optional `chatgpt` profile adds `openai-tunnel`, OpenAI's immutable-pinned Secure MCP Tunnel client. It long-polls outbound, forwards requests to `x-signal` over the private Compose network, reads its runtime key from a mounted secret file, and exposes only a loopback health endpoint. It is transport, not a model or worker service.

The app attaches to the browser through CDP. Browser and application data live in separate named volumes. Every enabled service has a health check and restarts automatically after a process failure.

## Research flow

1. A client calls `x_search`, an exact timeline tool, or a post/account reader.
2. The service binds the operation to the observed X account and persists its job state.
3. Chromium loads X and captures structured responses. The service parses normalized records and checkpoints accepted and consumed post IDs while scrolling.
4. SQLite stores posts, authors, observations, legs, cursors, clusters, monitor baselines, and exports.
5. The MCP response returns a bounded evidence page. Further evidence paging is local; search continuation performs more browser work only for selected legs.

## Correctness boundaries

- Runs and direct cursors are bound to the producing X account.
- Exact post identity is the deduplication boundary; similar independent posts are preserved.
- Work uses fenced leases so cancelled or superseded workers cannot persist late results.
- Direct cursors remember seen IDs and survive restarts.
- Monitor baselines advance only after successful delivery.

## Rate and session safety

One persistent browser handles all X traffic. Normal browser concurrency is capped at two, starts are spaced globally, matching requests are coalesced, caches are account-scoped and bounded, and upstream cooldowns pause unfinished work. Challenges and expired sessions become visible states.

The optional Chrome companion sends only X/Twitter cookie records to the loopback app. One named Chrome source is active at a time, account changes wait for active research to settle, and cookie values are never returned by tools.

## Client surface

The server exposes standard read-only `search` and `fetch` tools alongside richer X research tools for multi-angle search, paging, continuation, accounts, posts, feeds, jobs, monitors, and exports. No tool writes to X, and the server exposes no generic browser-control tool.
