# Operations

## Start and stop

```bash
docker compose up -d --build --wait
docker compose ps
docker compose logs --since 10m x-signal browser
docker compose down
```

`docker compose down` keeps both named volumes. Adding `-v` permanently removes the saved research database and browser profile.

The app exposes these main loopback-only endpoints:

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:7345/healthz` | Application health |
| `http://127.0.0.1:7345/readyz` | App and browser readiness |
| `http://127.0.0.1:7345/metrics` | Service metrics |
| `http://127.0.0.1:7345/mcp` | Streamable HTTP MCP |
| `http://127.0.0.1:6080/vnc.html` | Interactive browser |
| `http://127.0.0.1:7346/readyz` | Optional Secure MCP Tunnel readiness |

The companion extension currently expects the default app port, 7345. If you change `XSIGNAL_PORT`, update the extension host permission and endpoint before loading it.

## Check a local installation

The Docker-only readiness check does not require Node:

```bash
docker compose ps
curl -fsS http://127.0.0.1:7345/readyz
```

For the full source and MCP checks:

```bash
npm ci
npm run validate
npm run test:docker
npm run test:live
```

The live canary makes real X reads. Do not run it repeatedly when a normal research job already proves the connection.

## Back up and restore

Backup and restore require Node 24.19 or newer.

The backup command briefly stops both services, writes application and browser archives, records SHA-256 checksums, and restarts the stack. Disposable browser caches are excluded.

```bash
npm run backup -- /private/path/x-signal-backup
```

The browser archive contains a reusable signed-in profile. Store it as credential-bearing material and encrypt it with your normal backup system.

Restore verifies both checksums before replacing either volume:

```bash
npm run restore -- /private/path/x-signal-backup --confirm-replace
```

## Rate limits and recovery

X Signal uses one persistent browser, at most two browser tasks at once, globally spaced starts, request coalescing, a short account-scoped cache, and adaptive backoff.

When `x_status.rateControl.limited` is true, keep the existing run and wait until `retryAt`. Polling a run reads SQLite and does not repeat browser work. Interrupted leg leases return to the queue after restart, and accepted page checkpoints count toward the original target.

## Monitors

Monitors can run query legs, selected accounts, or an exact Following feed on an interval or daily schedule. They store a comparable baseline, prepare a diff only after a complete run, and advance that baseline only after successful delivery.

Webhook and ntfy targets require public HTTPS by default and are revalidated after redirects. Set `XSIGNAL_ALLOW_PRIVATE_MONITOR_SINKS=1` only for an intentional local development receiver.

## ChatGPT tunnel

After local configuration, start the stable private connection with:

```bash
npm run tunnel:secure:check
docker compose --profile chatgpt up -d --wait
docker compose --profile chatgpt ps
```

`openai-tunnel` is supervised with `restart: unless-stopped`, uses the internal `http://x-signal:7345/mcp` address, and publishes only its health page on host loopback. A Docker or host restart keeps the same tunnel identity; the ChatGPT app does not need to be recreated. If the sidecar is offline, calls wait or fail until it reconnects.

To rotate the runtime key, create another key with only **Tunnels → Read, Use**, run `npm run tunnel:secure:configure`, and recreate just the sidecar:

```bash
docker compose --profile chatgpt up -d --force-recreate --wait openai-tunnel
```

The short-lived fallback is for troubleshooting or a one-session demo:

```bash
npm run tunnel:chatgpt
```

The command requires `cloudflared` on your PATH. It exposes only a random secret path that forwards to `/mcp`; other paths return 404. Leave `XSIGNAL_MCP_BEARER_TOKEN` unset for this documented **No Auth** path-gated flow. Never point a public tunnel straight at port 7345.

Press Ctrl+C to stop both the proxy and the temporary HTTPS tunnel. Its URL expires and is not a durable app connection. Do not put it in issues, logs, screenshots, or committed configuration.
